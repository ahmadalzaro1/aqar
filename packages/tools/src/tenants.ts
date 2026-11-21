/**
 * Tenant read tools — search, arrears and one tenant's statement.
 *
 * The SQL lives here, once: the MCP adapter and the in-app chat call the same
 * handlers, so a change to the ledger query cannot drift between transports.
 * Money is formatted by `@aqar/core`; phone numbers never leave unmasked.
 */
import { z } from 'zod';
import { formatFils } from '@aqar/core';
import { ToolFailure } from './errors.js';
import type { ToolDef } from './registry.js';

/** Phone numbers are personal data: the agent sees the last four digits only. */
function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\s+/g, '');
  return digits.length <= 4 ? digits : `••••${digits.slice(-4)}`;
}

export const searchTenantsSchema = z.object({
  query: z.string().min(2).max(80).describe('Name fragment or last digits of the phone'),
  limit: z.number().int().min(1).max(50).default(10),
});

export const searchTenants: ToolDef = {
  name: 'search_tenants',
  kind: 'read',
  title: 'Search tenants',
  description:
    'Find tenants by name (English or Arabic) or phone fragment. Returns masked phone numbers; use the tenantId for follow-up tools.',
  schema: searchTenantsSchema,
  async run(ctx, raw) {
    const { query, limit } = searchTenantsSchema.parse(raw);
    const like = `%${query}%`;
    const rows = await ctx.sql<{
      id: string; nameEn: string | null; nameAr: string | null; phone: string | null;
      email: string | null; unitNumber: string | null; property: string | null;
      leaseStatus: string | null; endDate: string | null;
    }[]>`
      select t.id,
             t.full_name_en as "nameEn",
             t.full_name_ar as "nameAr",
             t.phone,
             t.email,
             u.unit_number as "unitNumber",
             p.name as property,
             l.status::text as "leaseStatus",
             to_char(l.end_date, 'YYYY-MM-DD') as "endDate"
        from tenants t
        left join lease_tenants lt on lt.tenant_id = t.id
        left join leases l on l.id = lt.lease_id and l.status in ('active', 'upcoming')
        left join units u on u.id = l.unit_id
        left join properties p on p.id = l.property_id
       where t.organization_id = ${ctx.org.id}
         and (
           t.full_name_en ilike ${like}
           or t.full_name_ar ilike ${like}
           or coalesce(t.phone, '') like ${like}
         )
       order by t.full_name_en nulls last
       limit ${limit}
    `;

    return {
      count: rows.length,
      tenants: rows.map((row) => ({
        tenantId: row.id,
        nameEn: row.nameEn,
        nameAr: row.nameAr,
        phoneMasked: maskPhone(row.phone),
        email: row.email,
        unitNumber: row.unitNumber,
        property: row.property,
        leaseStatus: row.leaseStatus,
        leaseEnds: row.endDate,
      })),
    };
  },
};

export const listArrearsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
});

export const listArrears: ToolDef = {
  name: 'list_arrears',
  kind: 'read',
  title: 'Tenants in arrears',
  description:
    'Every tenant whose allocated payments do not cover their charges, largest debt first, with the oldest unpaid due date. Amounts are integer fils.',
  schema: listArrearsSchema,
  async run(ctx, raw) {
    const { limit } = listArrearsSchema.parse(raw);
    const rows = await ctx.sql<{
      tenantId: string; nameEn: string | null; nameAr: string | null;
      unitNumber: string | null; property: string | null;
      chargedFils: string; allocatedFils: string; outstandingFils: string;
      oldestDue: string | null; daysLate: number | null; phone: string | null;
    }[]>`
      with charged as (
        select c.lease_id,
               sum(c.amount_fils)::bigint as amount,
               min(c.due_date) filter (where c.due_date <= current_date) as oldest_due
          from charges c
         where c.organization_id = ${ctx.org.id}
         group by c.lease_id
      ),
      allocated as (
        select c.lease_id, sum(pa.amount_fils)::bigint as amount
          from payment_allocations pa
          join charges c on c.id = pa.charge_id
         where pa.organization_id = ${ctx.org.id}
         group by c.lease_id
      )
      select t.id as "tenantId",
             t.full_name_en as "nameEn",
             t.full_name_ar as "nameAr",
             t.phone,
             u.unit_number as "unitNumber",
             p.name as property,
             coalesce(ch.amount, 0)::text as "chargedFils",
             coalesce(al.amount, 0)::text as "allocatedFils",
             (coalesce(ch.amount, 0) - coalesce(al.amount, 0))::text as "outstandingFils",
             to_char(ch.oldest_due, 'YYYY-MM-DD') as "oldestDue",
             case when ch.oldest_due is null then null else (current_date - ch.oldest_due) end as "daysLate"
        from tenants t
        join lease_tenants lt on lt.tenant_id = t.id
        join leases l on l.id = lt.lease_id and l.status = 'active'
        left join units u on u.id = l.unit_id
        left join properties p on p.id = l.property_id
        left join charged ch on ch.lease_id = l.id
        left join allocated al on al.lease_id = l.id
       where t.organization_id = ${ctx.org.id}
         and coalesce(ch.amount, 0) - coalesce(al.amount, 0) > 0
       order by (coalesce(ch.amount, 0) - coalesce(al.amount, 0)) desc
       limit ${limit}
    `;

    const tenants = rows.map((row) => {
      const outstanding = Number(row.outstandingFils);
      return {
        tenantId: row.tenantId,
        nameEn: row.nameEn,
        nameAr: row.nameAr,
        phoneMasked: maskPhone(row.phone),
        unitNumber: row.unitNumber,
        property: row.property,
        chargedFils: Number(row.chargedFils),
        allocatedFils: Number(row.allocatedFils),
        outstandingFils: outstanding,
        outstandingJod: formatFils(outstanding),
        oldestUnpaidDue: row.oldestDue,
        daysLate: row.daysLate,
      };
    });

    const totalOutstanding = tenants.reduce((sum, tenant) => sum + tenant.outstandingFils, 0);
    return {
      count: tenants.length,
      totalOutstandingFils: totalOutstanding,
      totalOutstandingJod: formatFils(totalOutstanding),
      tenants,
    };
  },
};

export const tenantStatementSchema = z.object({
  tenantId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(30),
});

export const tenantStatement: ToolDef = {
  name: 'tenant_statement',
  kind: 'read',
  title: 'Tenant statement',
  description:
    'One tenant: charges with what is still unpaid on each, payments received, and any payment promises. Use for "why is my balance like this" questions.',
  schema: tenantStatementSchema,
  async run(ctx, raw) {
    const { tenantId, limit } = tenantStatementSchema.parse(raw);

    const tenantRows = await ctx.sql<{ id: string; nameEn: string | null; nameAr: string | null; phone: string | null }[]>`
      select id, full_name_en as "nameEn", full_name_ar as "nameAr", phone
        from tenants
       where organization_id = ${ctx.org.id} and id = ${tenantId}
       limit 1
    `;
    const tenant = tenantRows[0];
    if (tenant === undefined) {
      throw new ToolFailure('tenant_not_found', `No tenant ${tenantId} in this organization`);
    }

    const charges = await ctx.sql<{
      id: string; period: string; kind: string; amountFils: number;
      dueDate: string; allocatedFils: string; outstandingFils: string; unitNumber: string | null;
    }[]>`
      select c.id,
             c.period,
             c.kind::text as kind,
             c.amount_fils as "amountFils",
             to_char(c.due_date, 'YYYY-MM-DD') as "dueDate",
             coalesce(sum(pa.amount_fils), 0)::text as "allocatedFils",
             (c.amount_fils - coalesce(sum(pa.amount_fils), 0))::text as "outstandingFils",
             u.unit_number as "unitNumber"
        from charges c
        join leases l on l.id = c.lease_id
        join lease_tenants lt on lt.lease_id = l.id
        left join units u on u.id = l.unit_id
        left join payment_allocations pa on pa.charge_id = c.id
       where c.organization_id = ${ctx.org.id}
         and lt.tenant_id = ${tenantId}
       group by c.id, u.unit_number
       order by c.due_date desc
       limit ${limit}
    `;

    const payments = await ctx.sql<{ id: string; amountFils: number; receivedDate: string; method: string; reference: string | null }[]>`
      select id,
             amount_fils as "amountFils",
             to_char(received_date, 'YYYY-MM-DD') as "receivedDate",
             method::text as method,
             reference_text as reference
        from payments
       where organization_id = ${ctx.org.id} and payer_id = ${tenantId}
       order by received_date desc
       limit ${limit}
    `;

    const promises = await ctx.sql<{ amountFils: number; promisedDate: string; status: string; note: string | null }[]>`
      select amount_fils as "amountFils",
             to_char(promised_date, 'YYYY-MM-DD') as "promisedDate",
             status,
             note
        from payment_promises
       where organization_id = ${ctx.org.id} and tenant_id = ${tenantId}
       order by promised_date desc
       limit 10
    `;

    const totalOutstanding = charges.reduce((sum, charge) => sum + Number(charge.outstandingFils), 0);

    return {
      tenant: {
        tenantId: tenant.id,
        nameEn: tenant.nameEn,
        nameAr: tenant.nameAr,
        phoneMasked: maskPhone(tenant.phone),
      },
      totalOutstandingFils: totalOutstanding,
      totalOutstandingJod: formatFils(totalOutstanding),
      charges: charges.map((charge) => ({
        chargeId: charge.id,
        period: charge.period,
        kind: charge.kind,
        unitNumber: charge.unitNumber,
        dueDate: charge.dueDate,
        amountFils: charge.amountFils,
        amountJod: formatFils(charge.amountFils),
        allocatedFils: Number(charge.allocatedFils),
        outstandingFils: Number(charge.outstandingFils),
        outstandingJod: formatFils(Math.max(0, Number(charge.outstandingFils))),
      })),
      payments: payments.map((payment) => ({
        paymentId: payment.id,
        receivedDate: payment.receivedDate,
        method: payment.method,
        reference: payment.reference,
        amountFils: payment.amountFils,
        amountJod: formatFils(payment.amountFils),
      })),
      promises: promises.map((promise) => ({
        amountFils: promise.amountFils,
        amountJod: formatFils(promise.amountFils),
        promisedDate: promise.promisedDate,
        status: promise.status,
        note: promise.note,
      })),
    };
  },
};

export const tenantsTools = [searchTenants, listArrears, tenantStatement] as const;
