/**
 * Deterministic question router.
 *
 * A 3B local model given 14 tools picks the wrong one. On the live console,
 * "how much does Khalil owe?" went to aqar_context twice and failed, then the model
 * produced a redirect. The records already contain the answer, so the route is
 * decided by rules first and the model is asked only when no rule is confident.
 *
 * Two signals, both cheap and exact:
 *   1. A tenant's full name appearing verbatim inside the question (substring match
 *      in SQL — no tokeniser, no stemming, works for Arabic and English names alike).
 *   2. A small keyword table of operator intents, ordered most specific first.
 *
 * Anything not matched falls through to the model, which keeps the assistant useful
 * for questions we did not enumerate.
 */
import type { Sql } from 'postgres';
import type { Locale } from '@aqar/contracts';

export interface RuleRoute {
  name: string;
  args: Record<string, unknown>;
  /** Why this route won — shown in the tool trace so the demo is auditable. */
  reason: string;
}

interface Intent {
  name: string;
  args: Record<string, unknown>;
  reason: string;
  pattern: RegExp;
}

/**
 * Ordered most-specific first: "كم تأمين نحتجز" must not be captured by the
 * arrears rule just because it mentions money, and a question about a *named*
 * person is handled before any of these (see routeQuestion).
 */
const INTENTS: Intent[] = [
  {
    name: 'deposits_held',
    args: {},
    reason: 'deposit keyword',
    pattern: /تأمين|تأمينات|ضمان|deposit|deposits/i,
  },
  {
    name: 'collections',
    args: {},
    reason: 'collection-rate keyword',
    pattern: /نسبة\s*التحصيل|التحصيل|محصّل|محصل|collection|collected|rate\s*%?/i,
  },
  {
    name: 'owner_statement',
    args: {},
    reason: 'owner-statement keyword',
    pattern:
      /صافي|الدخل\s*الصافي|كشف\s*المالك|أتعاب|اتعاب|noi|owner\s*statement|net\s*income|management\s*fee/i,
  },
  {
    name: 'rent_roll',
    args: {},
    reason: 'rent-roll keyword',
    pattern: /كشف\s*الإيجارات|كشف\s*الايجارات|rent\s*roll|وحدة\s*بوحدة|unit\s*by\s*unit/i,
  },
  {
    name: 'tenant_account',
    args: {},
    reason: 'statement keyword',
    pattern: /كشف\s*حساب|statement\s*for/i,
  },
  {
    name: 'list_vacant_units',
    args: {},
    reason: 'vacancy keyword',
    pattern: /شاغر|شاغرة|شواغر|فاضي|فاضية|vacan|empty|available\s*unit/i,
  },
  {
    name: 'list_expiring_leases',
    args: {},
    reason: 'renewal keyword',
    pattern: /ينتهي|تنتهي|انتهاء|تجديد|عقود\s*قريبة|expir|renew/i,
  },
  {
    name: 'list_open_tickets',
    args: {},
    reason: 'maintenance keyword',
    pattern: /تذاكر|صيانة|أعطال|اعطال|ticket|maintenance|repair/i,
  },
  {
    name: 'list_arrears',
    args: {},
    reason: 'arrears keyword',
    pattern:
      /متأخرات|متاخرات|متأخر|لم\s*يدفع|ما\s*دفع|مين\s*ما|arrears|overdue|who\s*(has\s*)?not\s*paid|unpaid/i,
  },
  {
    name: 'portfolio_summary',
    args: {},
    reason: 'portfolio keyword',
    pattern: /إشغال|اشغال|occupanc|محفظة|portfolio|كم\s*وحدة|how\s*many\s*units/i,
  },
];

/**
 * A tenant named inside the question wins over every keyword rule except deposits
 * and rent roll, which are about the whole book rather than one person.
 * Matched in SQL so the Arabic name does not have to be normalised in JS.
 */
export async function routeQuestion(
  sql: Sql,
  orgId: string,
  text: string,
): Promise<RuleRoute | null> {
  const bookWide = INTENTS.slice(0, 4).find((intent) => intent.pattern.test(text));
  if (bookWide !== undefined) {
    return { name: bookWide.name, args: bookWide.args, reason: bookWide.reason };
  }

  const [named] = await sql<{ name: string | null }[]>`
    select coalesce(full_name_ar, full_name_en) as name
      from tenants
     where organization_id = ${orgId}
       and (
         (full_name_ar is not null and length(full_name_ar) >= 5 and ${text} like '%' || full_name_ar || '%')
         or (full_name_en is not null and length(full_name_en) >= 5 and lower(${text}) like '%' || lower(full_name_en) || '%')
       )
     order by length(coalesce(full_name_ar, full_name_en)) desc
     limit 1
  `;
  if (named?.name) {
    return {
      name: 'tenant_account',
      args: { name: named.name },
      reason: 'tenant named in question',
    };
  }

  for (const intent of INTENTS.slice(4)) {
    if (intent.pattern.test(text)) {
      return { name: intent.name, args: intent.args, reason: intent.reason };
    }
  }
  return null;
}

/** Shown when the model or its provider is unusable: name what still works. */
export function degradedAnswer(locale: Locale): string {
  return locale === 'ar'
    ? 'مساعد النموذج غير متاح حاليًا، لكن هذه الأسئلة تُجاب مباشرة من السجلات دون نموذج: «كم يستحق على خليل عدنان الطراونة؟» · «شو نسبة التحصيل؟» · «كم تأمين نحتجز؟» · «عطيني كشف الإيجارات» · «شو صافي الدخل؟».'
    : 'The model assistant is unavailable right now, but these questions are answered straight from the records without it: "how much does Khalil owe?", "what is the collection rate?", "how much deposit are we holding?", "show me the rent roll", "what is net operating income?".';
}

/** Locale-correct nudge used when nothing matches, instead of a model apology. */
export function unknownQuestion(locale: Locale): string {
  return locale === 'ar'
    ? 'لم أحدد المقصود تمامًا. جرّب: «كم يستحق على خليل عدنان الطراونة؟» أو «شو نسبة التحصيل؟» أو «كم تأمين نحتجز؟»'
    : 'I could not map that to the records. Try: "how much does Khalil owe?", "what is the collection rate?", or "how much deposit are we holding?"';
}
