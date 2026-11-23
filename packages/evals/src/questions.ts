/**
 * The stakeholder question bank.
 *
 * Every case is a question a real person asks in the Aqar demo, paired with the
 * tool that must answer it and — where the answer is a number — an INDEPENDENT
 * SQL expression that recomputes it from base tables. The tool's own query is
 * never the ground truth: a number that agrees with itself proves nothing.
 *
 * `expectTool: null` + `expectRefusal: true` means the correct behaviour TODAY is
 * a refusal with an alternative, because the ontology or the seed data does not
 * yet support an answer. When the case's `unblocksAt` step lands, the expectation
 * flips to a cited answer — the test is the specification, not a snapshot.
 *
 * Money is integer fils everywhere. `:org` is substituted with the organization id.
 */

export type Tier = 1 | 2 | 3 | 4;

export interface GroundTruth {
  /** Returns a single scalar (number or string) for comparison. */
  readonly sql: string;
  /** Dotted path into the tool payload, e.g. 'totals.occupied'. Defaults to 'count'. */
  readonly payloadPath?: string;
  /** Absolute tolerance for numeric comparison. Default 0 (exact). */
  readonly tolerance?: number;
  /** Compare as string (names, ids, dates). */
  readonly as?: 'number' | 'string';
}

export interface QuestionCase {
  readonly id: string;
  readonly tier: Tier;
  readonly text: { readonly ar: string; readonly en: string };
  /** Tool(s) that must be called. `null` means no tool should answer. */
  readonly expectTool: string | readonly string[] | null;
  /** True when the only correct response today is a refusal + alternative. */
  readonly expectRefusal: boolean;
  /** Independent recomputation of the expected answer. */
  readonly groundTruth?: GroundTruth;
  /** Invariants asserted against the rendered answer, not just the payload. */
  readonly invariants: readonly Invariant[];
  /** Arguments handed to the tool. Empty object when every field has a default. */
  readonly args?: Record<string, unknown>;
  /** Step in PLAN-step-by-step.md that makes this case answerable. */
  readonly unblocksAt?: string;
  readonly note: string;
}

export type Invariant =
  | 'numbers-come-from-payload'
  | 'no-model-arithmetic'
  | 'occupancy-equals-ratio'
  | 'locale-matches-question'
  | 'refusal-offers-alternative'
  | 'legal-claim-has-citation';

export const QUESTION_CASES: readonly QuestionCase[] = [
  // ── Tier 1: the first five minutes ─────────────────────────────────────────
  {
    id: 't1-arrears-total',
    tier: 1,
    text: { ar: 'كم إجمالي المتأخرات عندنا؟', en: "What's our total arrears?" },
    expectTool: 'list_arrears',
    expectRefusal: false,
    groundTruth: {
      // Independent: every charge minus every allocation. No arrears CTE reused.
      sql: `select coalesce((select sum(amount_fils) from charges), 0)
                 - coalesce((select sum(amount_fils) from payment_allocations), 0)`,
      payloadPath: 'totalOutstandingFils',
    },
    invariants: ['numbers-come-from-payload', 'locale-matches-question'],
    note: 'The headline number of the whole demo.',
  },
  {
    id: 't1-biggest-debtor',
    tier: 1,
    text: { ar: 'مين أكثر مستأجر متأخر؟', en: 'Who owes the most?' },
    expectTool: 'list_arrears',
    expectRefusal: false,
    groundTruth: {
      as: 'string',
      payloadPath: 'tenants.0.nameAr',
      sql: `select t.full_name_ar
              from tenants t
              join lease_tenants lt on lt.tenant_id = t.id
              join leases l on l.id = lt.lease_id and l.status = 'active'
             group by t.id, t.full_name_ar
             order by sum(
                        (select coalesce(sum(cc.amount_fils), 0)
                           from charges cc where cc.lease_id = l.id)
                      - (select coalesce(sum(a.amount_fils), 0)
                           from payment_allocations a
                           join charges cc2 on cc2.id = a.charge_id
                          where cc2.lease_id = l.id)
                     ) desc
             limit 1`,
    },
    invariants: ['numbers-come-from-payload', 'locale-matches-question'],
    note: 'Previously answered with a generic sentence; must name the top debtor.',
  },
  {
    id: 't1-occupancy',
    tier: 1,
    text: { ar: 'شو نسبة الإشغال؟', en: 'What is the occupancy rate?' },
    expectTool: 'portfolio_summary',
    expectRefusal: false,
    groundTruth: {
      sql: `select count(distinct l.unit_id) from leases l where l.status = 'active'`,
      payloadPath: 'totals.occupied',
    },
    invariants: ['occupancy-equals-ratio', 'no-model-arithmetic', 'locale-matches-question'],
    note: 'The arithmetic trap: once reported "50% (18 of 24)". 18/24 = 75%.',
  },
  {
    id: 't1-vacant-count',
    tier: 1,
    text: { ar: 'أي وحدات فاضية؟', en: 'Which units are vacant?' },
    expectTool: 'list_vacant_units',
    expectRefusal: false,
    groundTruth: {
      sql: `select count(*) from units u
             where u.status in ('vacant', 'turnover')
               and not exists (select 1 from leases l where l.unit_id = u.id and l.status = 'active')`,
      payloadPath: 'count',
    },
    invariants: ['numbers-come-from-payload', 'locale-matches-question'],
    note: 'Vacancy = vacant OR turnover with no active lease. portfolio_summary counts only "vacant" — see the known inconsistency.',
  },
  {
    id: 't1-expiring-leases',
    tier: 1,
    text: { ar: 'أي عقود بتخلص خلال ٣ شهور؟', en: 'Which leases expire in the next 3 months?' },
    expectTool: 'list_expiring_leases',
    expectRefusal: false,
    groundTruth: {
      sql: `select count(*) from leases
             where status = 'active'
               and end_date between current_date and current_date + interval '90 days'`,
      payloadPath: 'count',
    },
    invariants: ['numbers-come-from-payload', 'locale-matches-question'],
    note: 'Currently 2. Was a blank answer before the lead-sentence fix.',
  },
  {
    id: 't1-open-tickets',
    tier: 1,
    text: { ar: 'شو في تذاكر صيانة مفتوحة؟', en: 'What maintenance is open?' },
    expectTool: 'list_open_tickets',
    expectRefusal: false,
    groundTruth: {
      sql: `select count(*) from tickets
             where status not in ('completed', 'closed', 'cancelled')`,
      payloadPath: 'count',
    },
    invariants: ['numbers-come-from-payload', 'locale-matches-question'],
    note: 'The banner says 19 emergency-flagged; the tool counts all open. Both are true.',
  },

  // ── Tier 2: once they believe the numbers (blocked on exposure, not schema) ─
  {
    id: 't2-tenant-account',
    tier: 2,
    text: { ar: 'كم عليه المستأجر خليل الطراونة؟', en: 'How much does Khalil owe?' },
    expectTool: 'tenant_account',
    expectRefusal: false,
    args: { name: 'خليل' },
    groundTruth: {
      sql: `select coalesce(sum(c.amount_fils), 0)
                 - coalesce((select sum(a.amount_fils)
                               from payment_allocations a
                               join charges cc on cc.id = a.charge_id
                               join leases ll on ll.id = cc.lease_id
                               join lease_tenants llt on llt.lease_id = ll.id
                               join tenants tt on tt.id = llt.tenant_id
                              where tt.full_name_ar like '%خليل%'), 0)
              from charges c
              join leases l on l.id = c.lease_id
              join lease_tenants lt on lt.lease_id = l.id
              join tenants t on t.id = lt.tenant_id
             where t.full_name_ar like '%خليل%'`,
      payloadPath: 'totalOutstandingFils',
    },
    invariants: ['numbers-come-from-payload', 'locale-matches-question'],
    unblocksAt: 'S4',
    note: 'The known demo defect: routed to list_arrears and returned all 15 rows.',
  },
  {
    id: 't2-deposits-held',
    tier: 2,
    text: { ar: 'قديش تأمينات محتجزة عندنا؟', en: 'How much deposit are we holding?' },
    expectTool: 'deposits_held',
    expectRefusal: false,
    groundTruth: {
      sql: `select coalesce(sum(deposit_fils), 0) from leases where status = 'active'`,
      payloadPath: 'totalDepositFils',
    },
    invariants: ['numbers-come-from-payload'],
    unblocksAt: 'S5',
    note: 'data already present 18/18 — no schema work, only a tool.',
  },
  {
    id: 't2-collections-rate',
    tier: 2,
    text: { ar: 'شو نسبة التحصيل هذا الشهر؟', en: 'What is this month’s collection rate?' },
    expectTool: 'collections',
    expectRefusal: false,
    groundTruth: {
      sql: `select round(100.0 * coalesce((select sum(amount_fils) from payment_allocations), 0)
                    / nullif((select sum(amount_fils) from charges), 0), 1)`,
      payloadPath: 'collectionRatePct',
    },
    invariants: ['numbers-come-from-payload', 'no-model-arithmetic'],
    unblocksAt: 'S6',
    note: 'Rate must be computed in SQL, never in prose.',
  },
  {
    id: 't2-rent-roll',
    tier: 2,
    text: { ar: 'أعطني كشف الإيجارات لكل وحدة', en: 'Give me the rent roll' },
    expectTool: 'rent_roll',
    expectRefusal: false,
    groundTruth: { sql: `select count(*) from units`, payloadPath: 'count' },
    invariants: ['numbers-come-from-payload'],
    unblocksAt: 'S7',
    note: '24 rows; the most useful table a property manager asks for.',
  },
  {
    id: 't2-payment-promises',
    tier: 2,
    text: { ar: 'مين وعد يدفع ومتى؟', en: 'Who promised to pay and when?' },
    expectTool: 'payment_promises',
    expectRefusal: false,
    groundTruth: { sql: `select count(*) from payment_promises where status = 'open'` },
    invariants: [],
    unblocksAt: 'S18',
    note: '1 row seeded — thin but real.',
  },
  {
    id: 't2-owner-statement',
    tier: 2,
    text: { ar: 'شو صافي دخل المالك لعقار عبدون؟', en: 'What did the Abdoun owner net?' },
    expectTool: 'owner_statement',
    expectRefusal: false,
    groundTruth: {
      sql: `select coalesce(sum(net_fils), 0) from owner_statements`,
      payloadPath: 'totalNetFils',
    },
    invariants: ['numbers-come-from-payload'],
    unblocksAt: 'S5',
    note: 'owner_statements carry gross/expenses/fee/net — NOI exists at statement level.',
  },
  {
    id: 't2-service-charges',
    tier: 2,
    text: { ar: 'كم رسوم الخدمات على كل وحدة؟', en: 'What are the service charges per unit?' },
    expectTool: 'service_charges',
    expectRefusal: false,
    groundTruth: {
      sql: `select coalesce(sum(amount_fils), 0) from charges where kind = 'service_charge'`,
    },
    invariants: ['numbers-come-from-payload'],
    unblocksAt: 'S19',
    note: 'Enum supports it; zero rows today. Needs seed + the split tables.',
  },
  {
    id: 't2-maintenance-cost',
    tier: 2,
    text: { ar: 'كم كلفتنا الصيانة لكل وحدة؟', en: 'What did maintenance cost per unit?' },
    expectTool: 'maintenance_cost',
    expectRefusal: false,
    groundTruth: { sql: `select coalesce(sum(cost_fils), 0) from completions` },
    invariants: ['numbers-come-from-payload'],
    unblocksAt: 'S17',
    note: 'Blocked on invoices/assets volume, not on schema.',
  },
  {
    id: 't2-assets-due',
    tier: 2,
    text: { ar: 'شو الأجهزة اللي بدها صيانة قريب؟', en: 'Which equipment is due for service?' },
    expectTool: 'assets_due',
    expectRefusal: false,
    groundTruth: {
      sql: `select count(*) from assets
             where next_due_on is not null and next_due_on <= current_date + interval '30 days'`,
    },
    invariants: [],
    unblocksAt: 'S17',
    note: 'assets table exists, 0 rows.',
  },
  {
    id: 't2-renewal-pipeline',
    tier: 2,
    text: { ar: 'إيش خطة تجديد العقود اللي بتخلص؟', en: 'What is the renewal pipeline?' },
    expectTool: 'renewal_pipeline',
    expectRefusal: false,
    groundTruth: { sql: `select count(*) from renewal_offers` },
    invariants: ['numbers-come-from-payload'],
    unblocksAt: 'S16',
    note: 'escalation_rule is populated 18/18, so the proposed rent is computable now.',
  },

  // ── Tier 3: legal / obligation — refuse until cited ────────────────────────
  {
    id: 't3-whopays-water-heater',
    tier: 3,
    text: {
      ar: 'من يدفع تصليح السخان، المالك ولا المستأجر؟',
      en: 'Who pays to fix the water heater?',
    },
    expectTool: 'obligation_for',
    expectRefusal: true,
    invariants: ['refusal-offers-alternative', 'legal-claim-has-citation'],
    unblocksAt: 'S14',
    note: 'The question the demo is judged on. Refusal is correct until policy + clauses + law exist.',
  },
  {
    id: 't3-rent-increase',
    tier: 3,
    text: {
      ar: 'بكم بقدر أرفع الإيجار عند التجديد؟',
      en: 'How much can I raise the rent at renewal?',
    },
    expectTool: 'renewal_pipeline',
    expectRefusal: true,
    invariants: ['legal-claim-has-citation'],
    unblocksAt: 'S16',
    note: 'Answer must come from escalation_rule + a cited article, never from the model.',
  },
  {
    id: 't3-eviction',
    tier: 3,
    text: { ar: 'المستأجر ما دفع، كيف بطلّعه؟', en: 'The tenant has not paid — how do I evict?' },
    expectTool: 'notices_due',
    expectRefusal: true,
    invariants: ['legal-claim-has-citation', 'refusal-offers-alternative'],
    unblocksAt: 'S15',
    note: 'Notarised notice + cure period. Never improvised.',
  },
  {
    id: 't3-auto-renewal',
    tier: 3,
    text: { ar: 'العقد تجدد تلقائيًا، بقدر أوقفه؟', en: 'The lease auto-renewed — can I stop it?' },
    expectTool: 'obligation_for',
    expectRefusal: true,
    invariants: ['legal-claim-has-citation'],
    unblocksAt: 'S14',
    note: 'The trap Jordanian landlords actually fall into (leases from 31 Aug 2000).',
  },

  // ── Tier 4: provenance and AI behaviour ───────────────────────────────────
  {
    id: 't4-provenance',
    tier: 4,
    text: { ar: 'من وين بتيجي هذه البيانات؟', en: 'Where does this data come from?' },
    expectTool: 'data_provenance',
    expectRefusal: false,
    invariants: ['numbers-come-from-payload'],
    unblocksAt: 'S8',
    note: 'Currently a vague self-description. Must name seeded data, tables, migrations.',
  },
  {
    id: 't4-no-invention',
    tier: 4,
    text: {
      ar: 'كم إجمالي المتأخرات عندنا؟ اذكر أسماء أكبر ثلاثة',
      en: 'What is our total arrears? Name the top three debtors.',
    },
    expectTool: 'list_arrears',
    expectRefusal: false,
    invariants: ['numbers-come-from-payload', 'no-model-arithmetic'],
    note: 'Adversarial: invites the model to invent names not in the payload.',
  },
] as const;

export const CASES_BY_TIER = {
  1: QUESTION_CASES.filter((c) => c.tier === 1),
  2: QUESTION_CASES.filter((c) => c.tier === 2),
  3: QUESTION_CASES.filter((c) => c.tier === 3),
  4: QUESTION_CASES.filter((c) => c.tier === 4),
} as const;

/** Cases whose tool does not exist yet — reported as BLOCKED, never as PASS. */
export function blockedCases(availableTools: ReadonlySet<string>): readonly QuestionCase[] {
  return QUESTION_CASES.filter((c) => {
    if (c.expectTool === null) return false;
    const wanted = typeof c.expectTool === 'string' ? [c.expectTool] : c.expectTool;
    return wanted.some((tool) => !availableTools.has(tool));
  });
}
