/**
 * Portfolio read tools — the SQL lives here, once, and both the MCP adapter and
 * the in-app chat call it. Money is formatted by `@aqar/core`; a model receives
 * both fils and a formatted string and is never asked to add them up.
 */
import { z } from 'zod';
import { formatFils } from '@aqar/core';
import type { ToolDef } from './registry.js';

interface PropertyRow {
  id: string;
  name: string;
  nameAr: string | null;
  district: string | null;
  units: string;
  occupied: string;
  vacant: string;
  openTickets: string;
  arrearsFils: string;
}

interface OrgTotalsRow {
  units: string;
  occupied: string;
  vacant: string;
  turnover: string;
  unavailable: string;
  activeLeases: string;
  arrearsFils: string;
  collectedFils: string;
  chargedFils: string;
  receivedFils: string;
}

const emptyArgs = z.object({});

export const portfolioSummary: ToolDef = {
  name: 'portfolio_summary',
  kind: 'read',
  title: 'Portfolio summary',
  description:
    'Occupancy, arrears totals and open tickets per property, plus organization totals. Start here for "how are we doing" questions. NOT for naming who owes: to answer "who has not paid", "مين ما دفع", "which tenants are late" or any per-tenant question, call list_arrears instead — this tool only returns totals. MONEY ARRIVES AS TOTALS — quote them, never sum property rows yourself. CASH RECEIVED IS NOT ARREARS RELIEF: totals.receivedJod is money in, totals.collectedJod is money applied to charges, and totals.unallocatedJod is the difference — if unallocated is above zero, say so rather than implying arrears fell.',
  schema: emptyArgs,
  async run(ctx, raw) {
    emptyArgs.parse(raw);
    const properties = await ctx.sql<PropertyRow[]>`
      with unit_stats as (
        select property_id,
               count(*) as units,
               count(*) filter (where status = 'occupied') as occupied,
               count(*) filter (where status = 'vacant') as vacant
          from units
         where organization_id = ${ctx.org.id}
         group by property_id
      ),
      charge_totals as (
        select l.property_id, sum(c.amount_fils)::bigint as charged
          from charges c
          join leases l on l.id = c.lease_id
         where c.organization_id = ${ctx.org.id}
         group by l.property_id
      ),
      alloc_totals as (
        select l.property_id, sum(pa.amount_fils)::bigint as allocated
          from payment_allocations pa
          join charges c on c.id = pa.charge_id
          join leases l on l.id = c.lease_id
         where pa.organization_id = ${ctx.org.id}
         group by l.property_id
      ),
      ticket_totals as (
        select property_id, count(*) as open_tickets
          from tickets
         where organization_id = ${ctx.org.id}
           and status not in ('closed', 'cancelled')
         group by property_id
      )
      select p.id,
             p.name,
             p.name_ar as "nameAr",
             p.district,
             coalesce(u.units, 0)::text as units,
             coalesce(u.occupied, 0)::text as occupied,
             coalesce(u.vacant, 0)::text as vacant,
             coalesce(t.open_tickets, 0)::text as "openTickets",
             (coalesce(ch.charged, 0) - coalesce(al.allocated, 0))::text as "arrearsFils"
        from properties p
        left join unit_stats u on u.property_id = p.id
        left join charge_totals ch on ch.property_id = p.id
        left join alloc_totals al on al.property_id = p.id
        left join ticket_totals t on t.property_id = p.id
       where p.organization_id = ${ctx.org.id}
       order by p.name
    `;

    const totals = await ctx.sql<OrgTotalsRow[]>`
      with charge_totals as (
        select sum(c.amount_fils)::bigint as charged
          from charges c where c.organization_id = ${ctx.org.id}
      ),
      alloc_totals as (
        select sum(pa.amount_fils)::bigint as allocated
          from payment_allocations pa where pa.organization_id = ${ctx.org.id}
      ),
      receipt_totals as (
        select coalesce(sum(p.amount_fils), 0)::bigint as received
          from payments p where p.organization_id = ${ctx.org.id}
      )
      select
        (select count(*)::text from units where organization_id = ${ctx.org.id}) as units,
        (select count(*)::text from units where organization_id = ${ctx.org.id} and status = 'occupied') as occupied,
        (select count(*)::text from units where organization_id = ${ctx.org.id} and status = 'vacant') as vacant,
        (select count(*)::text from units where organization_id = ${ctx.org.id} and status = 'turnover') as turnover,
        (select count(*)::text from units where organization_id = ${ctx.org.id} and status = 'unavailable') as unavailable,
        (select count(*)::text from leases where organization_id = ${ctx.org.id} and status = 'active') as "activeLeases",
        (coalesce(charge_totals.charged, 0) - coalesce(alloc_totals.allocated, 0))::text as "arrearsFils",
        coalesce(alloc_totals.allocated, 0)::text as "collectedFils",
        coalesce(charge_totals.charged, 0)::text as "chargedFils",
        coalesce(receipt_totals.received, 0)::text as "receivedFils"
        from charge_totals, alloc_totals, receipt_totals
    `;
    const total = totals[0];

    const propertyRows = properties.map((row) => {
      const units = Number(row.units);
      const occupied = Number(row.occupied);
      const arrears = Number(row.arrearsFils);
      return {
        propertyId: row.id,
        name: row.name,
        nameAr: row.nameAr,
        district: row.district,
        units,
        occupied,
        vacant: Number(row.vacant),
        occupancyPct: units === 0 ? 0 : Math.round((occupied / units) * 1000) / 10,
        openTickets: Number(row.openTickets),
        arrearsFils: arrears,
        arrearsJod: formatFils(arrears),
      };
    });

    return {
      properties: propertyRows,
      totals:
        total === undefined
          ? {}
          : {
              units: Number(total.units),
              occupied: Number(total.occupied),
              vacant: Number(total.vacant),
              turnover: Number(total.turnover),
              unavailable: Number(total.unavailable),
              activeLeases: Number(total.activeLeases),
              chargedFils: Number(total.chargedFils),
              chargedJod: formatFils(Number(total.chargedFils)),
              collectedFils: Number(total.collectedFils),
              collectedJod: formatFils(Number(total.collectedFils)),
              // Cash that arrived but has not been applied to a charge. It is not arrears
              // relief until it is allocated, and an operator who approves a payment
              // needs to see that gap instead of wondering why arrears did not move.
              receivedFils: Number(total.receivedFils),
              receivedJod: formatFils(Number(total.receivedFils)),
              unallocatedFils: Number(total.receivedFils) - Number(total.collectedFils),
              unallocatedJod: formatFils(Number(total.receivedFils) - Number(total.collectedFils)),
              arrearsFils: Number(total.arrearsFils),
              arrearsJod: formatFils(Number(total.arrearsFils)),
            },
    };
  },
};

export const vacantUnitsSchema = z.object({
  propertyId: z.string().uuid().optional().describe('Restrict to one property'),
  limit: z.number().int().min(1).max(200).default(50),
});

export const listVacantUnits: ToolDef = {
  name: 'list_vacant_units',
  kind: 'read',
  title: 'Vacant units',
  description:
    'Units with no active lease, with market rent and how long they have been empty. Use for "what can we lease" questions.',
  schema: vacantUnitsSchema,
  async run(ctx, raw) {
    const { propertyId, limit } = vacantUnitsSchema.parse(raw);
    const rows = await ctx.sql<
      {
        id: string;
        property: string;
        building: string | null;
        unitNumber: string;
        floor: string | null;
        bedrooms: number | null;
        marketRentFils: number | null;
        status: string;
        vacantSince: Date | null;
      }[]
    >`
      select u.id,
             p.name as property,
             b.name as building,
             u.unit_number as "unitNumber",
             u.floor,
             u.bedrooms,
             u.market_rent_fils as "marketRentFils",
             u.status::text as status,
             (select max(l.end_date) from leases l where l.unit_id = u.id and l.status = 'ended') as "vacantSince"
        from units u
        join properties p on p.id = u.property_id
        left join buildings b on b.id = u.building_id
       where u.organization_id = ${ctx.org.id}
         and u.status in ('vacant', 'turnover')
         and (${propertyId ?? null}::uuid is null or u.property_id = ${propertyId ?? null}::uuid)
         and not exists (
           select 1 from leases l
            where l.unit_id = u.id and l.status = 'active'
         )
       order by u.market_rent_fils desc nulls last
       limit ${limit}
    `;

    return {
      count: rows.length,
      units: rows.map((row) => ({
        unitId: row.id,
        property: row.property,
        building: row.building,
        unitNumber: row.unitNumber,
        floor: row.floor,
        bedrooms: row.bedrooms,
        status: row.status,
        marketRentFils: row.marketRentFils,
        marketRentJod: row.marketRentFils === null ? null : formatFils(row.marketRentFils),
        lastLeaseEnded:
          row.vacantSince === null ? null : row.vacantSince.toISOString().slice(0, 10),
      })),
    };
  },
};

export const expiringLeasesSchema = z.object({
  withinDays: z.number().int().min(1).max(720).default(90),
  limit: z.number().int().min(1).max(200).default(50),
});

export const listExpiringLeases: ToolDef = {
  name: 'list_expiring_leases',
  kind: 'read',
  title: 'Leases expiring soon',
  description:
    'Active leases ending within N days (default 90). Use for renewal planning and "who is leaving" questions.',
  schema: expiringLeasesSchema,
  async run(ctx, raw) {
    const { withinDays, limit } = expiringLeasesSchema.parse(raw);
    const rows = await ctx.sql<
      {
        leaseId: string;
        endDate: string;
        rentFils: number;
        unitNumber: string;
        property: string;
        tenant: string | null;
        tenantId: string | null;
        daysLeft: number;
      }[]
    >`
      select l.id as "leaseId",
             to_char(l.end_date, 'YYYY-MM-DD') as "endDate",
             l.rent_fils as "rentFils",
             u.unit_number as "unitNumber",
             p.name as property,
             coalesce(t.full_name_en, t.full_name_ar) as tenant,
             t.id as "tenantId",
             (l.end_date - current_date) as "daysLeft"
        from leases l
        join units u on u.id = l.unit_id
        join properties p on p.id = l.property_id
        left join lease_tenants lt on lt.lease_id = l.id and lt.is_primary
        left join tenants t on t.id = lt.tenant_id
       where l.organization_id = ${ctx.org.id}
         and l.status = 'active'
         and l.end_date between current_date and current_date + ${withinDays}::int
       order by l.end_date
       limit ${limit}
    `;

    return {
      withinDays,
      count: rows.length,
      leases: rows.map((row) => ({
        leaseId: row.leaseId,
        endDate: row.endDate,
        daysLeft: row.daysLeft,
        rentFils: row.rentFils,
        rentJod: formatFils(row.rentFils),
        unitNumber: row.unitNumber,
        property: row.property,
        tenant: row.tenant,
        tenantId: row.tenantId,
      })),
    };
  },
};

export const portfolioTools = [portfolioSummary, listVacantUnits, listExpiringLeases] as const;
