/**
 * Maintenance money and equipment service — the two questions a landlord asks
 * about the physical asset rather than the tenant.
 *
 *   maintenance_cost  what repairs actually cost, per unit and in total
 *   assets_due        which equipment is due for service
 *
 * Every total is computed by SQL over the whole set. A zero is returned as a
 * zero: "no repairs are recorded" is an answer, unlike a date that nobody
 * entered. Refusal is reserved for a question the data model cannot express.
 */
import { z } from 'zod';
import type { ToolDef } from './registry.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ────────────────────────────────────────────────────────────── maintenance_cost

export const maintenanceCostSchema = z.object({
  propertyId: uuid.optional(),
  from: isoDate
    .optional()
    .describe('Inclusive start date, YYYY-MM-DD. Default: all recorded history.'),
  to: isoDate.optional().describe('Inclusive end date, YYYY-MM-DD.'),
  limit: z.number().int().min(1).max(200).default(50),
});

export const maintenanceCost: ToolDef = {
  name: 'maintenance_cost',
  kind: 'read',
  title: 'Maintenance cost',
  description:
    'What repairs cost: total and per unit, from completed jobs (completions.cost_fils). Use for "كم كلفتنا الصيانة", "maintenance cost per unit", "how much did we spend on repairs", optionally scoped to a property or a date window. Reports the recorded figure even when it is zero.',
  schema: maintenanceCostSchema,
  async run(ctx, raw) {
    const { propertyId, from, to, limit } = maintenanceCostSchema.parse(raw);

    const rows = await ctx.sql<
      {
        unitId: string | null;
        unitNumber: string | null;
        property: string | null;
        propertyAr: string | null;
        jobs: number;
        costFils: number;
        lastCompleted: string | null;
      }[]
    >`
      select u.id as "unitId",
             u.unit_number as "unitNumber",
             p.name as property,
             p.name_ar as "propertyAr",
             count(c.id)::int as jobs,
             coalesce(sum(c.cost_fils), 0)::int as "costFils",
             max(c.completed_at)::date::text as "lastCompleted"
        from completions c
        left join tickets t on t.id = c.ticket_id
        left join units u on u.id = t.unit_id
        left join properties p on p.id = coalesce(t.property_id, u.property_id)
       where c.organization_id = ${ctx.org.id}
         and (${from ?? null}::date is null or c.completed_at >= ${from ?? null}::date)
         and (${to ?? null}::date is null or c.completed_at < ${to ?? null}::date + 1)
         and (${propertyId ?? null}::uuid is null or p.id = ${propertyId ?? null}::uuid)
       group by u.id, u.unit_number, p.name, p.name_ar
       order by "costFils" desc, jobs desc
       limit ${limit}
    `;

    const totals = await ctx.sql<{ totalFils: number; jobs: number; units: number }[]>`
      select coalesce(sum(c.cost_fils), 0)::int as "totalFils",
             count(c.id)::int as jobs,
             count(distinct t.unit_id)::int as units
        from completions c
        left join tickets t on t.id = c.ticket_id
        left join properties p on p.id = coalesce(t.property_id, (select u2.property_id from units u2 where u2.id = t.unit_id))
       where c.organization_id = ${ctx.org.id}
         and (${from ?? null}::date is null or c.completed_at >= ${from ?? null}::date)
         and (${to ?? null}::date is null or c.completed_at < ${to ?? null}::date + 1)
         and (${propertyId ?? null}::uuid is null or p.id = ${propertyId ?? null}::uuid)
    `;

    const total = totals[0] ?? { totalFils: 0, jobs: 0, units: 0 };
    const perUnitFils =
      total.units === 0 ? null : Math.round(total.totalFils / Math.max(total.units, 1));

    return {
      totalCostFils: total.totalFils,
      jobs: total.jobs,
      unitsWithCost: total.units,
      perUnitFils,
      from: from ?? null,
      to: to ?? null,
      rows,
      note:
        total.jobs === 0
          ? 'No completed repair is recorded for this window, so the cost is zero because nothing was logged — not because nothing was spent.'
          : null,
    };
  },
};

// ────────────────────────────────────────────────────────────────── assets_due

export const assetsDueSchema = z.object({
  withinDays: z.number().int().min(0).max(730).default(30),
  propertyId: uuid.optional(),
  includeOverdue: z.boolean().default(true),
});

export const assetsDue: ToolDef = {
  name: 'assets_due',
  kind: 'read',
  title: 'Equipment due for service',
  description:
    'Equipment whose next service date falls within N days (default 30), including anything already overdue. Use for "شو الأجهزة اللي بدها صيانة", "what is due for service", "which equipment is overdue". Returns an explicit count, so an empty register answers zero rather than refusing.',
  schema: assetsDueSchema,
  async run(ctx, raw) {
    const { withinDays, propertyId, includeOverdue } = assetsDueSchema.parse(raw);

    const rows = await ctx.sql<
      {
        id: string;
        label: string | null;
        kind: string;
        property: string | null;
        propertyAr: string | null;
        unitNumber: string | null;
        nextDueOn: string | null;
        daysUntil: number;
        responsibleParty: string | null;
        warrantyExpiresOn: string | null;
      }[]
    >`
      select a.id,
             a.label,
             a.kind::text as kind,
             p.name as property,
             p.name_ar as "propertyAr",
             u.unit_number as "unitNumber",
             a.next_due_on::text as "nextDueOn",
             (a.next_due_on - current_date)::int as "daysUntil",
             a.responsible_party::text as "responsibleParty",
             a.warranty_expires_on::text as "warrantyExpiresOn"
        from assets a
        left join properties p on p.id = a.property_id
        left join units u on u.id = a.unit_id
       where a.organization_id = ${ctx.org.id}
         and a.next_due_on is not null
         and a.next_due_on <= current_date + ${withinDays}::int
         and (${includeOverdue}::boolean or a.next_due_on >= current_date)
         and (${propertyId ?? null}::uuid is null or a.property_id = ${propertyId ?? null}::uuid)
       order by a.next_due_on asc
       limit 200
    `;

    const registered = await ctx.sql<{ n: number }[]>`
      select count(*)::int as n from assets where organization_id = ${ctx.org.id}
    `;

    return {
      count: rows.length,
      withinDays,
      assetsRegistered: registered[0]?.n ?? 0,
      rows,
      note:
        (registered[0]?.n ?? 0) === 0
          ? 'No equipment is registered, so nothing can be due. Registering an asset (assets) with a service interval is what makes this answerable.'
          : null,
    };
  },
};

export const maintenanceTools: readonly ToolDef[] = [maintenanceCost, assetsDue];
