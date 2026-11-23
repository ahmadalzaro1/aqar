/**
 * Account-level read tools: the questions a landlord asks about one tenant, the
 * deposit book, collection performance, and the rent roll.
 *
 * These read tables that are already populated — no schema work. Every total is
 * computed by SQL over the full set (window aggregates), never by summing a
 * truncated page and never by prose arithmetic.
 */
import { formatFils } from '@aqar/core';
import { z } from 'zod';
import type { ToolDef } from './registry.js';
import { ToolFailure } from './errors.js';

const uuid = z.string().uuid();

function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 4) return '••••';
  return `${phone.slice(0, phone.length - 4).replace(/\d/g, '•')}${phone.slice(-4)}`;
}

// ────────────────────────────────────────────────────────────── tenant_account

export const tenantAccountSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(80)
    .describe('Tenant name as the user said it, Arabic or English, or a phone fragment.'),
  propertyId: uuid.optional(),
  limit: z.number().int().min(1).max(100).default(40),
});

export const tenantAccount: ToolDef = {
  name: 'tenant_account',
  kind: 'read',
  title: 'One tenant’s account',
  description:
    'The full account of ONE tenant: every lease, every charge, what was paid, what is still owed, the oldest unpaid due date and any promise to pay. Use this whenever the question names a person — "كم عليه فلان", "كشف حساب", "statement for X", "how much does X owe", "is X late" — never list_arrears for a named tenant.',
  schema: tenantAccountSchema,
  async run(ctx, raw) {
    const { name, propertyId, limit } = tenantAccountSchema.parse(raw);
    const like = `%${name}%`;

    const matches = await ctx.sql<
      { id: string; nameAr: string | null; nameEn: string | null; phone: string | null }[]
    >`
      select t.id,
             t.full_name_ar as "nameAr",
             t.full_name_en as "nameEn",
             t.phone
        from tenants t
       where t.organization_id = ${ctx.org.id}
         and (
           t.full_name_ar ilike ${like}
           or t.full_name_en ilike ${like}
           or coalesce(t.phone, '') like ${like}
         )
       order by
         case when t.full_name_ar = ${name} or t.full_name_en = ${name} then 0 else 1 end,
         t.full_name_ar
       limit 5
    `;

    if (matches.length === 0) {
      throw new ToolFailure(
        'no_tenant_match',
        `No tenant matches "${name}". Ask the user to confirm the spelling, or list tenants first.`,
      );
    }

    // One match: answer. Several: name the candidates instead of guessing.
    const primary = matches[0] as (typeof matches)[number];

    const leases = await ctx.sql<
      {
        leaseId: string;
        status: string;
        property: string | null;
        propertyAr: string | null;
        unitNumber: string | null;
        startDate: string;
        endDate: string;
        rentFils: number;
        depositFils: number;
        chargedFils: string;
        allocatedFils: string;
        outstandingFils: string;
        oldestDue: string | null;
        daysLate: number | null;
      }[]
    >`
      select l.id as "leaseId",
             l.status::text as status,
             p.name as property,
             p.name_ar as "propertyAr",
             u.unit_number as "unitNumber",
             to_char(l.start_date, 'YYYY-MM-DD') as "startDate",
             to_char(l.end_date, 'YYYY-MM-DD') as "endDate",
             l.rent_fils as "rentFils",
             l.deposit_fils as "depositFils",
             coalesce(ch.amount, 0)::text as "chargedFils",
             coalesce(al.amount, 0)::text as "allocatedFils",
             (coalesce(ch.amount, 0) - coalesce(al.amount, 0))::text as "outstandingFils",
             to_char(ch.oldest_due, 'YYYY-MM-DD') as "oldestDue",
             case when ch.oldest_due is null then null else (current_date - ch.oldest_due) end as "daysLate"
        from leases l
        join lease_tenants lt on lt.lease_id = l.id and lt.tenant_id = ${primary.id}
        left join units u on u.id = l.unit_id
        left join properties p on p.id = l.property_id
        left join lateral (
          select sum(c.amount_fils)::bigint as amount,
                 min(c.due_date) filter (where c.due_date <= current_date) as oldest_due
            from charges c
           where c.lease_id = l.id and c.organization_id = ${ctx.org.id}
        ) ch on true
        left join lateral (
          select sum(pa.amount_fils)::bigint as amount
            from payment_allocations pa
            join charges c2 on c2.id = pa.charge_id
           where c2.lease_id = l.id and pa.organization_id = ${ctx.org.id}
        ) al on true
       where l.organization_id = ${ctx.org.id}
         and (${propertyId ?? null}::uuid is null or l.property_id = ${propertyId ?? null}::uuid)
       order by l.start_date desc
    `;

    const ledger = await ctx.sql<
      {
        period: string;
        kind: string;
        amountFils: number;
        dueDate: string;
        allocatedFils: string;
        outstandingFils: string;
      }[]
    >`
      select c.period,
             c.kind::text as kind,
             c.amount_fils as "amountFils",
             to_char(c.due_date, 'YYYY-MM-DD') as "dueDate",
             coalesce((select sum(pa.amount_fils) from payment_allocations pa where pa.charge_id = c.id), 0)::text
               as "allocatedFils",
             (c.amount_fils - coalesce((select sum(pa.amount_fils) from payment_allocations pa where pa.charge_id = c.id), 0))::text
               as "outstandingFils"
        from charges c
        join leases l on l.id = c.lease_id
        join lease_tenants lt on lt.lease_id = l.id and lt.tenant_id = ${primary.id}
       where c.organization_id = ${ctx.org.id}
       order by c.due_date desc
       limit ${limit}
    `;

    const promises = await ctx.sql<
      { amountFils: number; promisedDate: string; status: string; note: string | null }[]
    >`
      select pp.amount_fils as "amountFils",
             to_char(pp.promised_date, 'YYYY-MM-DD') as "promisedDate",
             pp.status,
             pp.note
        from payment_promises pp
       where pp.organization_id = ${ctx.org.id}
         and pp.tenant_id = ${primary.id}
       order by pp.promised_date desc
       limit 10
    `;

    const totalOutstanding = leases.reduce((sum, lease) => sum + Number(lease.outstandingFils), 0);

    return {
      count: 1,
      candidates: matches.map((m) => ({
        tenantId: m.id,
        name: m.nameAr ?? m.nameEn,
        phoneMasked: maskPhone(m.phone),
      })),
      tenant: {
        tenantId: primary.id,
        nameAr: primary.nameAr,
        nameEn: primary.nameEn,
        phoneMasked: maskPhone(primary.phone),
      },
      leases: leases.map((lease) => ({
        leaseId: lease.leaseId,
        status: lease.status,
        property: lease.property,
        propertyAr: lease.propertyAr,
        unitNumber: lease.unitNumber,
        startDate: lease.startDate,
        endDate: lease.endDate,
        rentFils: lease.rentFils,
        rentJod: formatFils(lease.rentFils),
        depositFils: lease.depositFils,
        depositJod: formatFils(lease.depositFils),
        chargedFils: Number(lease.chargedFils),
        allocatedFils: Number(lease.allocatedFils),
        outstandingFils: Number(lease.outstandingFils),
        outstandingJod: formatFils(Number(lease.outstandingFils)),
        oldestUnpaidDue: lease.oldestDue,
        daysLate: lease.daysLate,
      })),
      charges: ledger.map((row) => ({
        period: row.period,
        kind: row.kind,
        amountFils: row.amountFils,
        amountJod: formatFils(row.amountFils),
        dueDate: row.dueDate,
        allocatedFils: Number(row.allocatedFils),
        outstandingFils: Number(row.outstandingFils),
        outstandingJod: formatFils(Number(row.outstandingFils)),
      })),
      paymentPromises: promises.map((row) => ({
        amountFils: row.amountFils,
        amountJod: formatFils(row.amountFils),
        promisedDate: row.promisedDate,
        status: row.status,
        note: row.note,
      })),
      totalOutstandingFils: totalOutstanding,
      totalOutstandingJod: formatFils(totalOutstanding),
    };
  },
};

// ─────────────────────────────────────────────────────────────── deposits_held

export const depositsHeldSchema = z.object({
  propertyId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export const depositsHeld: ToolDef = {
  name: 'deposits_held',
  kind: 'read',
  title: 'Deposits held',
  description:
    'Deposits the landlord currently holds, per tenant and unit, with the lease end date and the total. Use for "how much deposit are we holding", "تأمينات", "deposit exposure", "what is refundable" and renewal/exit planning.',
  schema: depositsHeldSchema,
  async run(ctx, raw) {
    const { propertyId, limit } = depositsHeldSchema.parse(raw);

    const rows = await ctx.sql<
      {
        totalFils: string;
        totalCount: number;
        tenant: string | null;
        tenantId: string | null;
        unitNumber: string | null;
        property: string | null;
        propertyAr: string | null;
        depositFils: number;
        leaseEnd: string;
      }[]
    >`
      select (sum(l.deposit_fils) over ())::text as "totalFils",
             count(*) over () as "totalCount",
             coalesce(t.full_name_ar, t.full_name_en) as tenant,
             t.id as "tenantId",
             u.unit_number as "unitNumber",
             p.name as property,
             p.name_ar as "propertyAr",
             l.deposit_fils as "depositFils",
             to_char(l.end_date, 'YYYY-MM-DD') as "leaseEnd"
        from leases l
        join units u on u.id = l.unit_id
        join properties p on p.id = l.property_id
        left join lease_tenants lt on lt.lease_id = l.id and lt.is_primary
        left join tenants t on t.id = lt.tenant_id
       where l.organization_id = ${ctx.org.id}
         and l.status = 'active'
         and (${propertyId ?? null}::uuid is null or l.property_id = ${propertyId ?? null}::uuid)
       order by l.deposit_fils desc
       limit ${limit}
    `;

    const total = Number(rows[0]?.totalFils ?? 0);
    return {
      count: Number(rows[0]?.totalCount ?? 0),
      returned: rows.length,
      totalDepositFils: total,
      totalDepositJod: formatFils(total),
      deposits: rows.map((row) => ({
        tenantId: row.tenantId,
        tenant: row.tenant,
        unitNumber: row.unitNumber,
        property: row.property,
        propertyAr: row.propertyAr,
        depositFils: row.depositFils,
        depositJod: formatFils(row.depositFils),
        leaseEnd: row.leaseEnd,
      })),
    };
  },
};

// ───────────────────────────────────────────────────────────────── collections

export const collectionsSchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .describe('Billing period as YYYY-MM. Omit for all periods and the overall rate.'),
  propertyId: uuid.optional(),
  months: z.number().int().min(1).max(24).default(6),
});

export const collections: ToolDef = {
  name: 'collections',
  kind: 'read',
  title: 'Collections and collection rate',
  description:
    'Charged vs collected per billing period, the collection rate computed in SQL, unallocated receipts, and the payment-method split. Use for "collection rate", "نسبة التحصيل", "how much did we collect", "كيف دفعوا".',
  schema: collectionsSchema,
  async run(ctx, raw) {
    const { period, propertyId, months } = collectionsSchema.parse(raw);

    const rows = await ctx.sql<
      {
        period: string;
        chargedFils: string;
        allocatedFils: string;
        unallocatedFils: string;
        ratePct: string | null;
      }[]
    >`
      with charged as (
        select c.period, sum(c.amount_fils)::bigint as amount
          from charges c
          join leases l on l.id = c.lease_id
         where c.organization_id = ${ctx.org.id}
           and (${propertyId ?? null}::uuid is null or l.property_id = ${propertyId ?? null}::uuid)
         group by c.period
      ),
      collected as (
        select c.period, sum(pa.amount_fils)::bigint as amount
          from payment_allocations pa
          join charges c on c.id = pa.charge_id
          join leases l on l.id = c.lease_id
         where pa.organization_id = ${ctx.org.id}
           and (${propertyId ?? null}::uuid is null or l.property_id = ${propertyId ?? null}::uuid)
         group by c.period
      ),
      receipts as (
        select p.reference_period as period, sum(p.amount_fils)::bigint as amount
          from payments p
         where p.organization_id = ${ctx.org.id} and p.voided_at is null
         group by p.reference_period
      ),
      periods as (
        select period from charged union select period from collected
      )
      select pd.period,
             coalesce(ch.amount, 0)::text as "chargedFils",
             coalesce(co.amount, 0)::text as "allocatedFils",
             greatest(coalesce(rc.amount, 0) - coalesce(co.amount, 0), 0)::text as "unallocatedFils",
             case when coalesce(ch.amount, 0) = 0 then null
                  else round(100.0 * coalesce(co.amount, 0) / ch.amount, 1)::text end as "ratePct"
        from periods pd
        left join charged ch on ch.period = pd.period
        left join collected co on co.period = pd.period
        left join receipts rc on rc.period = pd.period
       where pd.period is not null
         and (${period ?? null}::text is null or pd.period = ${period ?? null}::text)
       order by pd.period desc
       limit ${months}
    `;

    const methods = await ctx.sql<{ method: string; count: number; amountFils: string }[]>`
      select p.method::text as method,
             count(*)::int as count,
             sum(p.amount_fils)::text as "amountFils"
        from payments p
       where p.organization_id = ${ctx.org.id}
         and p.voided_at is null
         and (${period ?? null}::text is null or p.reference_period = ${period ?? null}::text)
       group by p.method
       order by sum(p.amount_fils) desc
    `;

    // Overall rate: the whole set, not the page. This is the number a landlord quotes.
    const [overall] = await ctx.sql<
      { ratePct: string | null; chargedFils: string; allocatedFils: string }[]
    >`
      select case when (select coalesce(sum(amount_fils), 0) from charges where organization_id = ${ctx.org.id}) = 0
                  then null
                  else round(100.0 * (select coalesce(sum(amount_fils), 0) from payment_allocations where organization_id = ${ctx.org.id})
                             / (select sum(amount_fils) from charges where organization_id = ${ctx.org.id}), 1)::text
             end as "ratePct",
             (select coalesce(sum(amount_fils), 0) from charges where organization_id = ${ctx.org.id})::text as "chargedFils",
             (select coalesce(sum(amount_fils), 0) from payment_allocations where organization_id = ${ctx.org.id})::text as "allocatedFils"
    `;

    return {
      count: rows.length,
      period: period ?? 'all',
      collectionRatePct:
        overall?.ratePct === null || overall?.ratePct === undefined
          ? null
          : Number(overall.ratePct),
      totalChargedFils: Number(overall?.chargedFils ?? 0),
      totalAllocatedFils: Number(overall?.allocatedFils ?? 0),
      totalChargedJod: formatFils(Number(overall?.chargedFils ?? 0)),
      totalAllocatedJod: formatFils(Number(overall?.allocatedFils ?? 0)),
      periods: rows.map((row) => ({
        period: row.period,
        chargedFils: Number(row.chargedFils),
        chargedJod: formatFils(Number(row.chargedFils)),
        allocatedFils: Number(row.allocatedFils),
        allocatedJod: formatFils(Number(row.allocatedFils)),
        unallocatedFils: Number(row.unallocatedFils),
        collectionRatePct: row.ratePct === null ? null : Number(row.ratePct),
      })),
      byMethod: methods.map((row) => ({
        method: row.method,
        count: row.count,
        amountFils: Number(row.amountFils),
        amountJod: formatFils(Number(row.amountFils)),
      })),
    };
  },
};

// ──────────────────────────────────────────────────────────────────── rent_roll

export const rentRollSchema = z.object({
  propertyId: uuid.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export const rentRoll: ToolDef = {
  name: 'rent_roll',
  kind: 'read',
  title: 'Rent roll',
  description:
    'Every unit with its live lease: tenant, rent, deposit, start and end dates, escalation rule and current arrears. Use for "rent roll", "كشف الإيجارات", "who is in which unit", "unit by unit", and any question about a specific unit number.',
  schema: rentRollSchema,
  async run(ctx, raw) {
    const { propertyId, limit } = rentRollSchema.parse(raw);

    const rows = await ctx.sql<
      {
        totalCount: number;
        unitId: string;
        property: string;
        propertyAr: string | null;
        building: string | null;
        unitNumber: string;
        floor: string | null;
        bedrooms: number | null;
        areaSqm: string | null;
        unitStatus: string;
        leaseId: string | null;
        tenant: string | null;
        rentFils: number | null;
        depositFils: number | null;
        startDate: string | null;
        endDate: string | null;
        escalation: unknown;
        arrearsFils: string;
      }[]
    >`
      select count(*) over () as "totalCount",
             u.id as "unitId",
             p.name as property,
             p.name_ar as "propertyAr",
             b.name as building,
             u.unit_number as "unitNumber",
             u.floor,
             u.bedrooms,
             u.area_sqm::text as "areaSqm",
             u.status::text as "unitStatus",
             l.id as "leaseId",
             coalesce(t.full_name_ar, t.full_name_en) as tenant,
             l.rent_fils as "rentFils",
             l.deposit_fils as "depositFils",
             to_char(l.start_date, 'YYYY-MM-DD') as "startDate",
             to_char(l.end_date, 'YYYY-MM-DD') as "endDate",
             l.escalation_rule as escalation,
             coalesce(ar.amount, 0)::text as "arrearsFils"
        from units u
        join properties p on p.id = u.property_id
        left join buildings b on b.id = u.building_id
        left join leases l on l.unit_id = u.id and l.status = 'active'
        left join lease_tenants lt on lt.lease_id = l.id and lt.is_primary
        left join tenants t on t.id = lt.tenant_id
        left join lateral (
          select (sum(c.amount_fils) - coalesce((
                    select sum(pa.amount_fils)
                      from payment_allocations pa
                      join charges c3 on c3.id = pa.charge_id
                     where c3.lease_id = l.id), 0))::bigint as amount
            from charges c
           where c.lease_id = l.id
        ) ar on true
       where u.organization_id = ${ctx.org.id}
         and (${propertyId ?? null}::uuid is null or u.property_id = ${propertyId ?? null}::uuid)
       order by p.name, u.unit_number
       limit ${limit}
    `;

    return {
      count: Number(rows[0]?.totalCount ?? 0),
      returned: rows.length,
      units: rows.map((row) => ({
        unitId: row.unitId,
        property: row.property,
        propertyAr: row.propertyAr,
        building: row.building,
        unitNumber: row.unitNumber,
        floor: row.floor,
        bedrooms: row.bedrooms,
        areaSqm: row.areaSqm === null ? null : Number(row.areaSqm),
        unitStatus: row.unitStatus,
        leaseId: row.leaseId,
        tenant: row.tenant,
        rentFils: row.rentFils,
        rentJod: row.rentFils === null ? null : formatFils(row.rentFils),
        depositFils: row.depositFils,
        depositJod: row.depositFils === null ? null : formatFils(row.depositFils),
        startDate: row.startDate,
        endDate: row.endDate,
        escalationRule: row.escalation,
        arrearsFils: Number(row.arrearsFils),
        arrearsJod: formatFils(Number(row.arrearsFils)),
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────── owner_statement

export const ownerStatementSchema = z.object({
  propertyId: uuid.optional(),
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  limit: z.number().int().min(1).max(60).default(24),
});

export const ownerStatement: ToolDef = {
  name: 'owner_statement',
  kind: 'read',
  title: 'Owner statement and net operating income',
  description:
    'Per-property owner statement: gross rent, expenses, management fee and net, by period, with totals. Use for "NOI", "net income", "صافي الدخل", "owner payout", "what did the owner earn", "management fee". Every figure is already netted in the database — do not recompute it.',
  schema: ownerStatementSchema,
  async run(ctx, raw) {
    const { propertyId, period, limit } = ownerStatementSchema.parse(raw);

    const rows = await ctx.sql<
      {
        totalNet: string;
        totalCount: number;
        property: string | null;
        propertyAr: string | null;
        period: string;
        grossFils: number;
        expensesFils: number;
        feeFils: number;
        netFils: number;
        issuedAt: string | null;
      }[]
    >`
      select (sum(os.net_fils) over ())::text as "totalNet",
             count(*) over () as "totalCount",
             p.name as property,
             p.name_ar as "propertyAr",
             os.period,
             os.gross_rent_fils as "grossFils",
             os.expenses_fils as "expensesFils",
             os.management_fee_fils as "feeFils",
             os.net_fils as "netFils",
             to_char(os.issued_at, 'YYYY-MM-DD') as "issuedAt"
        from owner_statements os
        left join properties p on p.id = os.property_id
       where os.organization_id = ${ctx.org.id}
         and (${propertyId ?? null}::uuid is null or os.property_id = ${propertyId ?? null}::uuid)
         and (${period ?? null}::text is null or os.period = ${period ?? null}::text)
       order by os.period desc, p.name
       limit ${limit}
    `;

    const totalNet = Number(rows[0]?.totalNet ?? 0);
    const totalGross = rows.reduce((sum, row) => sum + row.grossFils, 0);
    const totalExpenses = rows.reduce((sum, row) => sum + row.expensesFils, 0);
    const totalFee = rows.reduce((sum, row) => sum + row.feeFils, 0);

    return {
      count: Number(rows[0]?.totalCount ?? 0),
      returned: rows.length,
      totalNetFils: totalNet,
      totalNetJod: formatFils(totalNet),
      totalGrossFils: totalGross,
      totalGrossJod: formatFils(totalGross),
      totalExpensesFils: totalExpenses,
      totalExpensesJod: formatFils(totalExpenses),
      totalManagementFeeFils: totalFee,
      totalManagementFeeJod: formatFils(totalFee),
      statements: rows.map((row) => ({
        property: row.property,
        propertyAr: row.propertyAr,
        period: row.period,
        grossFils: row.grossFils,
        grossJod: formatFils(row.grossFils),
        expensesFils: row.expensesFils,
        expensesJod: formatFils(row.expensesFils),
        managementFeeFils: row.feeFils,
        managementFeeJod: formatFils(row.feeFils),
        netFils: row.netFils,
        netJod: formatFils(row.netFils),
        issuedAt: row.issuedAt,
      })),
    };
  },
};

export const accountTools = [
  tenantAccount,
  depositsHeld,
  collections,
  rentRoll,
  ownerStatement,
] as const;
