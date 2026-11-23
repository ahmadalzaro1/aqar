/**
 * Operating spend — the half of the ledger that has no supplier invoice.
 *
 * `completions.cost_fils` answers repair cost; `invoices` answers supplier
 * bills; `expenses` answers everything the organisation pays itself:
 * electricity, water, municipal fees, insurance, tax, salaries. A zero is a
 * real answer here, so this tool reports zeros rather than refusing.
 */
import { z } from 'zod';
import type { ToolDef } from './registry.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const expenseCategory = z.enum([
  'utilities_electricity',
  'utilities_water',
  'utilities_gas',
  'municipal_fees',
  'insurance',
  'property_tax',
  'salaries',
  'cleaning',
  'security',
  'management',
  'legal',
  'marketing',
  'other',
]);

export const operatingSpendSchema = z.object({
  category: expenseCategory.optional(),
  propertyId: uuid.optional(),
  from: isoDate.optional().describe('Inclusive start, YYYY-MM-DD. Default: current calendar year.'),
  to: isoDate.optional().describe('Inclusive end, YYYY-MM-DD.'),
});

export const operatingSpend: ToolDef = {
  name: 'operating_spend',
  kind: 'read',
  title: 'Operating spend',
  description:
    'What the organisation spent on running the property — utilities, municipal fees, insurance, tax, salaries, cleaning, security — by category and by property, for a date window (default: this calendar year). Use for "كم صرفنا على الكهرباء", "what did we spend on utilities", "operating costs this year". Repair costs are not here: use maintenance_cost for those.',
  schema: operatingSpendSchema,
  async run(ctx, raw) {
    const { category, propertyId, from, to } = operatingSpendSchema.parse(raw);
    const start = from ?? `${new Date().getFullYear()}-01-01`;
    const end = to ?? null;

    const byCategory = await ctx.sql<{ category: string; amountFils: number; entries: number }[]>`
      select e.category::text as category,
             coalesce(sum(e.amount_fils), 0)::int as "amountFils",
             count(*)::int as entries
        from expenses e
       where e.organization_id = ${ctx.org.id}
         and e.incurred_on >= ${start}::date
         and (${end}::date is null or e.incurred_on <= ${end}::date)
         and (${category ?? null}::text is null or e.category::text = ${category ?? null}::text)
         and (${propertyId ?? null}::uuid is null or e.property_id = ${propertyId ?? null}::uuid)
       group by e.category
       order by "amountFils" desc
    `;

    const byProperty = await ctx.sql<
      { property: string | null; propertyAr: string | null; amountFils: number }[]
    >`
      select p.name as property,
             p.name_ar as "propertyAr",
             coalesce(sum(e.amount_fils), 0)::int as "amountFils"
        from expenses e
        left join properties p on p.id = e.property_id
       where e.organization_id = ${ctx.org.id}
         and e.incurred_on >= ${start}::date
         and (${end}::date is null or e.incurred_on <= ${end}::date)
         and (${category ?? null}::text is null or e.category::text = ${category ?? null}::text)
         and (${propertyId ?? null}::uuid is null or e.property_id = ${propertyId ?? null}::uuid)
       group by p.name, p.name_ar
       order by "amountFils" desc
    `;

    const totalFils = byCategory.reduce((sum, row) => sum + row.amountFils, 0);

    return {
      totalFils,
      from: start,
      to: end,
      category: category ?? null,
      byCategory,
      byProperty,
      note:
        byCategory.length === 0
          ? 'No expense is recorded for this window. The total is zero because nothing was entered — utility and municipal costs are not derivable from leases or charges.'
          : null,
    };
  },
};

export const spendTools: readonly ToolDef[] = [operatingSpend];
