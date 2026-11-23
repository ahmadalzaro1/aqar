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
 * Tier-3 intents carry an argument, so they cannot live in the static table.
 * A clause word maps to the vocabulary the tool accepts — nothing else does, so
 * an unrecognised repair question falls through to the nudge instead of a guess.
 */
const CLAUSE_WORDS: ReadonlyArray<{ pattern: RegExp; clause: string; equipmentKind?: string }> = [
  {
    pattern: /سخان|سخانات|أجهزة|اجهزة|water\s*heater|appliance|boiler/i,
    clause: 'repairs_appliance',
    // Naming the equipment lets the tool consult the recorded maintenance
    // policy; without it the same question can only reach the legal corpus.
    equipmentKind: 'water_heater',
  },
  {
    pattern: /إنشائي|انشائي|هيكل|سطح|تسريب|structural|roof|foundation/i,
    clause: 'repairs_structural',
    equipmentKind: 'structure',
  },
  {
    pattern: /رسوم\s*الخدمات|خدمات\s*المبنى|service\s*charge|building\s*fee/i,
    clause: 'service_charge',
  },
  { pattern: /من\s*الباطن|sublet|sub-let/i, clause: 'sublet' },
  { pattern: /حيوان|حيوانات|pet/i, clause: 'pets' },
  { pattern: /استرداد\s*التأمين|تأمين\s*مسترد|deposit\s*refund/i, clause: 'deposit_refund' },
  { pattern: /إنهاء\s*مبكر|انهاء\s*مبكر|early\s*termination|فسخ/i, clause: 'early_termination' },
  { pattern: /تجديد\s*تلقائي|auto[\s-]*renew/i, clause: 'auto_renewal' },
  { pattern: /حق\s*الدخول|زيارة\s*الوحدة|entry\s*right/i, clause: 'entry_rights' },
];

/** The question has to be about responsibility before a clause is worth resolving. */
const RESPONSIBILITY =
  /من\s*يدفع|مين\s*يدفع|على\s*من|مسؤول|مسؤولية|who\s*pays|who\s*is\s*responsible|responsible\s*for/i;
const NOTICE_ASK = /إشعار|اشعار|إخطار|اخطار|إنذار|انذار|notice|eviction/i;
const RENEWAL_ASK =
  /تجديد|جدّد|جدد\s*العقد|عرض\s*تجديد|renew|renewal|زيادة\s*الإيجار|rent\s*increase/i;

function clauseFor(text: string): { clause: string; equipmentKind?: string } | null {
  if (!RESPONSIBILITY.test(text)) return null;
  for (const entry of CLAUSE_WORDS) {
    if (entry.pattern.test(text)) {
      return entry.equipmentKind === undefined
        ? { clause: entry.clause }
        : { clause: entry.clause, equipmentKind: entry.equipmentKind };
    }
  }
  return null;
}

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

  // Tier-3: renewal and notices before the generic expiring-lease rule, which
  // answers a narrower question ("what ends soon") than "what do we renew".
  const clause = clauseFor(text);
  if (clause !== null) {
    return {
      name: 'obligation_for',
      args: clause,
      reason: `responsibility for ${clause.clause}`,
    };
  }
  if (NOTICE_ASK.test(text)) {
    return { name: 'notices_due', args: { horizonDays: 60 }, reason: 'notices and deadlines' };
  }
  if (RENEWAL_ASK.test(text)) {
    return { name: 'renewal_pipeline', args: { days: 120 }, reason: 'renewal pipeline' };
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
/** A refusal is an answer, not an error — say it in the language that was asked. */
export function refusalAnswer(code: string, locale: 'ar' | 'en'): string {
  const ar: Record<string, string> = {
    no_notices:
      'لا يوجد أي إشعار صادر مسجّل حتى الآن، لذلك لا يوجد تاريخ استحقاق يُحسب. يُسجَّل الإشعار أولًا في سجل الإشعارات، ويُحسب تاريخ الاستحقاق تلقائيًا من مدة الإخطار المكتوبة في العقد.',
    no_obligation_record:
      'لا يوجد سند موثّق لهذه المسألة: لا بند في العقود، ولا قرار مسؤولية مسجّل لهذا النوع من التجهيزات، ولا مادة قانونية مراجَعة. لن أخمّن. لتُصبح قابلة للإجابة يجب تسجيل بند العقد، أو تسجيل قرار المسؤولية (من يتحمّل الصيانة ونوع السند)، أو إدخال المادة القانونية مع رابط المصدر واسم من راجعها.',
    not_found: 'لم أجد السجل المطلوب ضمن بيانات المؤسسة.',
    no_rows: 'لا توجد صفوف مطابقة في البيانات الحالية.',
  };
  const en: Record<string, string> = {
    no_notices:
      'No outgoing notice is recorded yet, so there is no deadline to compute. Once a notice is entered, its due date is derived from the notice period written into the lease.',
    no_obligation_record:
      'There is no documented basis for this: no lease clause, no recorded responsibility decision for this equipment, and no reviewed legal article. I will not guess. Record the clause, record the responsibility decision (who bears the repair, and on what basis), or enter the article with its source URL and reviewer.',
    not_found: 'No matching record in this organisation.',
    no_rows: 'No rows match in the current data.',
  };
  const table = locale === 'ar' ? ar : en;
  return (
    table[code] ??
    (locale === 'ar'
      ? 'تعذّر إكمال الطلب من البيانات المتاحة، ولم أخمّن النتيجة.'
      : 'The request could not be answered from the available data, and I did not guess.')
  );
}

export function unknownQuestion(locale: Locale): string {
  return locale === 'ar'
    ? 'لم أحدد المقصود تمامًا. جرّب: «كم يستحق على خليل عدنان الطراونة؟» أو «شو نسبة التحصيل؟» أو «كم تأمين نحتجز؟»'
    : 'I could not map that to the records. Try: "how much does Khalil owe?", "what is the collection rate?", or "how much deposit are we holding?"';
}
