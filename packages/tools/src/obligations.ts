/**
 * Obligation and renewal tools — the Tier-3 answers.
 *
 * These exist because three landlord questions have no answer in the ledger:
 * who pays for a repair, what a renewal will cost, and when an eviction notice
 * matures. Each answer here is either (a) computed from a stored term, or
 * (b) a refusal that names the exact record that would make it answerable.
 * There is deliberately no third path: the handler never returns prose the
 * database cannot support.
 */
import { z } from 'zod';
import { formatFils } from '@aqar/core';
import { ToolFailure } from './errors.js';
import type { ToolDef } from './registry.js';

const obligationKind = z.enum([
  'repairs_structural',
  'repairs_appliance',
  'service_charge',
  'sublet',
  'pets',
  'notice_period',
  'escalation',
  'deposit_refund',
  'early_termination',
  'auto_renewal',
  'entry_rights',
]);

/** Mirrors the equipment_kind enum. Kept as a literal so a typo is a type error. */
const equipmentKind = z.enum([
  'structure',
  'roof',
  'envelope',
  'water_supply',
  'water_tank',
  'pump',
  'drainage',
  'sewer',
  'gas_network',
  'gas_cylinder',
  'electrical_panel',
  'wiring',
  'generator',
  'solar',
  'hvac_split',
  'hvac_central',
  'water_heater',
  'elevator',
  'fire_alarm',
  'fire_extinguisher',
  'fire_riser',
  'security_access',
  'cctv',
  'intercom',
  'door_lock',
  'kitchen',
  'appliance',
  'plumbing_fixture',
  'lighting',
  'parking_equipment',
  'signage',
  'other',
]);

export const obligationForSchema = z.object({
  clause: obligationKind.describe('The obligation to resolve, in the clause vocabulary'),
  equipmentKind: equipmentKind
    .optional()
    .describe(
      'The piece of equipment the question names. Supplying it enables the maintenance_policy lookup, which is how "who pays for the water heater" gets a real answer instead of a refusal.',
    ),
  leaseId: z.uuid().optional().describe('A specific lease; omit to answer for the whole portfolio'),
});

interface ClauseRow {
  leaseId: string;
  clauseKey: string;
  value: Record<string, unknown>;
  textAr: string | null;
  textEn: string | null;
  extractedBy: string | null;
  confidence: string | null;
  confirmed: boolean;
  unitNumber: string | null;
  property: string | null;
  propertyAr: string | null;
}

interface PolicyRow {
  responsibility: string;
  wearVsDamage: string;
  basis: string;
  noteAr: string | null;
  noteEn: string | null;
  propertyId: string | null;
  property: string | null;
  propertyAr: string | null;
  effectiveFrom: string;
  instrument: string | null;
  article: string | null;
  sourceUrl: string | null;
  reviewedBy: string | null;
}

/**
 * Resolve one obligation. Order is fixed and auditable: the lease's own terms
 * first (a contract beats a default), then the reviewed legal corpus, then a
 * refusal naming both gaps.
 */
export const obligationFor: ToolDef = {
  name: 'obligation_for',
  kind: 'read',
  title: 'Who is responsible for an obligation',
  description:
    'Answer "who pays for this / who decides this" for one clause of the lease vocabulary. Returns the lease clause when one exists, otherwise the reviewed legal basis, otherwise a refusal naming the missing record. Never guesses.',
  schema: obligationForSchema,
  async run(ctx, raw) {
    const { clause, equipmentKind: equipment, leaseId } = obligationForSchema.parse(raw);

    const clauses = await ctx.sql<ClauseRow[]>`
      select lc.lease_id as "leaseId",
             lc.clause_key as "clauseKey",
             lc.value,
             lc.text_ar as "textAr",
             lc.text_en as "textEn",
             lc.extracted_by as "extractedBy",
             lc.confidence::text as "confidence",
             (lc.extracted_by = 'human'
              or (lc.extracted_by like 'parser:%' and lc.confidence >= 0.95)) as confirmed,
             u.unit_number as "unitNumber",
             p.name as property,
             p.name_ar as "propertyAr"
        from lease_clauses lc
        join leases l on l.id = lc.lease_id
        left join units u on u.id = l.unit_id
        left join properties p on p.id = l.property_id
       where lc.organization_id = ${ctx.org.id}
         and lc.clause_key = ${clause}
         and (${leaseId ?? null}::uuid is null or lc.lease_id = ${leaseId ?? null}::uuid)
       order by (lc.extracted_by = 'human') desc, lc.confidence desc nulls last
       limit 20
    `;

    if (clauses.length > 0) {
      const confirmed = clauses.filter((c) => c.confirmed);
      return {
        basis: 'lease_clause',
        clause,
        confirmedCount: confirmed.length,
        unconfirmedCount: clauses.length - confirmed.length,
        rows: clauses.map((c) => ({
          leaseId: c.leaseId,
          unitNumber: c.unitNumber,
          property: c.property,
          propertyAr: c.propertyAr,
          value: c.value,
          textAr: c.textAr,
          textEn: c.textEn,
          confirmed: c.confirmed,
          provenance: c.extractedBy ?? 'unknown',
          confidence: c.confidence,
        })),
        note:
          confirmed.length === 0
            ? 'All matching clauses were parsed automatically and none is reviewed. Reported as unconfirmed, not as the answer.'
            : null,
      };
    }

    // A recorded policy decision beats a general statute, and a property row
    // beats an organisation row. This is the branch that answers the water
    // heater without inventing anything: if no row exists, we fall through.
    if (equipment !== undefined) {
      const scope = leaseId
        ? await ctx.sql<{ propertyId: string | null }[]>`
            select property_id as "propertyId"
              from leases
             where id = ${leaseId} and organization_id = ${ctx.org.id}
             limit 1
          `
        : [];
      const propertyId = scope[0]?.propertyId ?? null;

      const policies = await ctx.sql<PolicyRow[]>`
        select mp.responsibility::text as responsibility,
               mp.wear_vs_damage::text as "wearVsDamage",
               mp.basis,
               mp.note_ar as "noteAr",
               mp.note_en as "noteEn",
               mp.property_id as "propertyId",
               p.name as property,
               p.name_ar as "propertyAr",
               mp.effective_from::text as "effectiveFrom",
               lr.instrument,
               lr.article,
               lr.source_url as "sourceUrl",
               lr.reviewed_by as "reviewedBy"
          from maintenance_policy mp
          left join properties p on p.id = mp.property_id
          left join legal_reference lr on lr.id = mp.legal_reference_id
         where mp.organization_id = ${ctx.org.id}
           and mp.equipment_kind = ${equipment}::equipment_kind
           and mp.effective_to is null
           and (
             (${propertyId}::uuid is not null
              and (mp.property_id is null or mp.property_id = ${propertyId}::uuid))
             or (${propertyId}::uuid is null and mp.property_id is null)
           )
         order by (mp.property_id is not null) desc
         limit 1
      `;

      const policy = policies[0];
      if (policy !== undefined) {
        return {
          basis: 'maintenance_policy',
          clause,
          equipmentKind: equipment,
          responsibility: policy.responsibility,
          wearVsDamage: policy.wearVsDamage,
          policyBasis: policy.basis,
          scope: policy.propertyId === null ? 'organization' : 'property',
          property: policy.property,
          propertyAr: policy.propertyAr,
          effectiveFrom: policy.effectiveFrom,
          citation:
            policy.instrument === null
              ? null
              : {
                  instrument: policy.instrument,
                  article: policy.article,
                  sourceUrl: policy.sourceUrl,
                  reviewedBy: policy.reviewedBy,
                },
          noteAr: policy.noteAr,
          noteEn: policy.noteEn,
          // A policy is a decision someone recorded, not a contract term.
          confirmed: false,
          note: 'Recorded as a maintenance policy, not as a lease term. Confirm against the lease before acting on it.',
        };
      }
    }

    const legal = await ctx.sql<
      {
        instrument: string;
        article: string | null;
        summaryAr: string;
        summaryEn: string;
        sourceUrl: string;
        reviewedBy: string;
      }[]
    >`
      select instrument, article, summary_ar as "summaryAr", summary_en as "summaryEn",
             source_url as "sourceUrl", reviewed_by as "reviewedBy"
        from legal_reference_citable
       where applies_to = 'repairs'
         and (article = ${clause} or applies_to = ${clause})
       limit 5
    `;

    if (legal.length > 0) {
      return { basis: 'legal_reference', clause, rows: legal };
    }

    throw new ToolFailure(
      'no_obligation_record',
      `No lease clause of type "${clause}" and no reviewed legal article answers this.`,
      'Record the clause on the lease (lease_clauses), record a responsibility decision for this equipment kind (maintenance_policy: responsibility + basis), or cite a reviewed article (legal_reference with source_url and reviewed_by). Until then the console refuses rather than guessing.',
    );
  },
};

export const noticesDueSchema = z.object({
  horizonDays: z.number().int().min(1).max(365).default(30),
});

/**
 * Notices that have been served (or must be served) and when each matures.
 * The cure deadline is served_at + the lease's notice period. A lease that does
 * not record a notice period cannot produce a deadline — each such row is
 * returned with `dueDate: null` and a reason instead of a made-up date.
 */
export const noticesDue: ToolDef = {
  name: 'notices_due',
  kind: 'read',
  title: 'Notices and their deadlines',
  description:
    'List served notices with the date each obligation matures, computed from the lease notice period. Rows without a recorded notice period are returned with a null deadline and the reason.',
  schema: noticesDueSchema,
  async run(ctx, raw) {
    const { horizonDays } = noticesDueSchema.parse(raw);
    const rows = await ctx.sql<
      {
        noticeId: string;
        leaseId: string;
        kind: string;
        direction: string;
        servedAt: string | null;
        method: string | null;
        acknowledgedAt: string | null;
        noticePeriodDays: number | null;
        dueDate: string | null;
        unitNumber: string | null;
        property: string | null;
        propertyAr: string | null;
        tenantName: string | null;
      }[]
    >`
      select n.id as "noticeId", n.lease_id as "leaseId", n.kind::text, n.direction::text,
             to_char(n.served_at, 'YYYY-MM-DD') as "servedAt", n.method,
             to_char(n.acknowledged_at, 'YYYY-MM-DD') as "acknowledgedAt",
             l.notice_period_days as "noticePeriodDays",
             case when n.served_at is not null and l.notice_period_days is not null
                  then to_char(n.served_at + make_interval(days => l.notice_period_days), 'YYYY-MM-DD')
             end as "dueDate",
             u.unit_number as "unitNumber",
             p.name as property, p.name_ar as "propertyAr",
             coalesce(t.full_name_ar, t.full_name_en) as "tenantName"
        from notices n
        join leases l on l.id = n.lease_id
        left join units u on u.id = l.unit_id
        left join properties p on p.id = l.property_id
        left join tenants t on t.id = n.tenant_id
       where n.organization_id = ${ctx.org.id}
         and n.direction = 'to_tenant'
         and (n.served_at is null
              or n.served_at + make_interval(days => coalesce(l.notice_period_days, 0)) >= current_date - make_interval(days => ${horizonDays}))
       order by n.served_at desc nulls last
       limit 50
    `;

    const computable = rows.filter((r) => r.dueDate !== null).length;
    const missing = rows.length - computable;

    if (rows.length === 0) {
      throw new ToolFailure(
        'no_notices',
        'No outgoing notice has been recorded for this portfolio.',
        'Serve a notice through the notices workflow first; the console will not invent a deadline from a lease end date.',
      );
    }

    return {
      rows,
      count: rows.length,
      computableDeadlines: computable,
      missingNoticePeriod: missing,
      note:
        missing > 0
          ? `${missing} of ${rows.length} notices sit on leases with no recorded notice period, so no deadline can be computed for them.`
          : null,
    };
  },
};

export const renewalPipelineSchema = z.object({
  days: z.number().int().min(7).max(365).default(90),
});

/**
 * Leases expiring inside a window, with the renewal arithmetic done in SQL:
 * proposed rent = current rent + the lease's own escalation rule. When the rule
 * is `{"kind":"none"}` the tool says so — "no increase in the contract" — rather
 * than applying an industry default that is not in the document.
 */
export const renewalPipeline: ToolDef = {
  name: 'renewal_pipeline',
  kind: 'read',
  title: 'Renewal pipeline',
  description:
    'Leases expiring within N days with the escalation rule stored on each lease, the resulting proposed rent, days to expiry, the notice window and any renewal offer already sent.',
  schema: renewalPipelineSchema,
  async run(ctx, raw) {
    const { days } = renewalPipelineSchema.parse(raw);
    const rows = await ctx.sql<
      {
        leaseId: string;
        unitNumber: string | null;
        property: string | null;
        propertyAr: string | null;
        tenantName: string | null;
        endDate: string;
        daysToExpiry: number;
        rentFils: number;
        proposedFils: number;
        escalationKind: string;
        escalationPct: string | null;
        noticePeriodDays: number | null;
        autoRenew: boolean;
        offerStatus: string | null;
        offeredFils: number | null;
      }[]
    >`
      select l.id as "leaseId",
             u.unit_number as "unitNumber",
             p.name as property, p.name_ar as "propertyAr",
             coalesce(t.full_name_ar, t.full_name_en) as "tenantName",
             to_char(l.end_date, 'YYYY-MM-DD') as "endDate",
             (l.end_date - current_date) as "daysToExpiry",
             l.rent_fils as "rentFils",
             round(l.rent_fils * (1 + coalesce((l.escalation_rule->>'percent')::numeric, 0) / 100)) as "proposedFils",
             coalesce(l.escalation_rule->>'kind', 'none') as "escalationKind",
             l.escalation_rule->>'percent' as "escalationPct",
             l.notice_period_days as "noticePeriodDays",
             l.auto_renew as "autoRenew",
             ro.status::text as "offerStatus",
             ro.offered_rent_fils as "offeredFils"
        from leases l
        left join units u on u.id = l.unit_id
        left join properties p on p.id = l.property_id
        left join lease_tenants lt on lt.lease_id = l.id and lt.is_primary
        left join tenants t on t.id = lt.tenant_id
        left join lateral (
          select status, offered_rent_fils from renewal_offers
           where lease_id = l.id order by created_at desc limit 1
        ) ro on true
       where l.organization_id = ${ctx.org.id}
         and l.status = 'active'
         and l.end_date between current_date and current_date + make_interval(days => ${days})
       order by l.end_date asc
       limit 50
    `;

    if (rows.length === 0) {
      return {
        rows: [],
        count: 0,
        windowDays: days,
        note: `No active lease expires within ${days} days.`,
      };
    }

    return {
      count: rows.length,
      windowDays: days,
      totalRentFils: rows.reduce((s, r) => s + Number(r.rentFils), 0),
      totalProposedFils: rows.reduce((s, r) => s + Number(r.proposedFils), 0),
      rows: rows.map((r) => ({
        ...r,
        // pg returns bigint and numeric as strings; the formatter takes an integer.
        rent: formatFils(Number(r.rentFils)),
        proposed: formatFils(Number(r.proposedFils)),
        offered: r.offeredFils === null ? null : formatFils(Number(r.offeredFils)),
        escalationRule:
          r.escalationKind === 'none'
            ? 'لا تتضمن هذه الاتفاقية زيادة — التمديد بنفس الإيجار'
            : `${r.escalationKind} ${r.escalationPct ?? ''}%`.trim(),
      })),
    };
  },
};

export const obligationTools: readonly ToolDef[] = [obligationFor, noticesDue, renewalPipeline];
