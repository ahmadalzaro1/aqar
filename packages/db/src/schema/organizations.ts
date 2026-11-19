import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { auditTimestamps, pkId } from './common.js';

/**
 * M1 root aggregate. `organizations` is the only table that is not itself
 * tenant-scoped: it *is* the tenant. Every other table carries organization_id.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: pkId(),
    name: text('name').notNull(),
    nameAr: text('name_ar').notNull(),
    slug: text('slug').notNull().unique(),
    /** IANA timezone used for quiet hours, due dates and SLA clocks. */
    timezone: text('timezone').notNull().default('Asia/Amman'),
    /** ISO 4217; JOD only in this product, kept explicit for reporting. */
    currency: text('currency').notNull().default('JOD'),
    ...auditTimestamps(),
  },
  (t) => [index('organizations_slug_idx').on(t.slug)],
);
