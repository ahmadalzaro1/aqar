import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, isoDate, pkId } from './common.js';
import {
  invoiceStatusEnum,
  quoteStatusEnum,
  vendorJobStatusEnum,
} from './enums.js';
import { organizations } from './organizations.js';
import { tickets } from './m5-maintenance.js';
import { vendors } from './vendors.js';

/** M6 — scheduled work handed to a vendor. */
export const vendorJobs = pgTable(
  'vendor_jobs',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    status: vendorJobStatusEnum('status').notNull().default('scheduled'),
    title: text('title').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    quotedFils: integer('quoted_fils').notNull().default(0),
    actualFils: integer('actual_fils'),
    ...auditTimestamps(),
  },
  (t) => [
    index('vendor_jobs_org_idx').on(t.organizationId),
    index('vendor_jobs_vendor_idx').on(t.vendorId),
    index('vendor_jobs_ticket_idx').on(t.ticketId),
    check('vendor_jobs_quoted_ck', sql`${t.quotedFils} >= 0`),
    check('vendor_jobs_actual_ck', sql`${t.actualFils} IS NULL OR ${t.actualFils} >= 0`),
  ],
);

/** M6 — price quote against a ticket (or a job). */
export const quotes = pgTable(
  'quotes',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    vendorJobId: uuid('vendor_job_id').references(() => vendorJobs.id, { onDelete: 'cascade' }),
    status: quoteStatusEnum('status').notNull().default('requested'),
    amountFils: integer('amount_fils').notNull(),
    validUntil: isoDate('valid_until'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('quotes_org_idx').on(t.organizationId),
    index('quotes_vendor_idx').on(t.vendorId),
    check('quotes_amount_ck', sql`${t.amountFils} >= 0`),
    check('quotes_target_ck', sql`${t.ticketId} IS NOT NULL OR ${t.vendorJobId} IS NOT NULL`),
  ],
);

/** M6 — vendor invoice. Line detail lives in the vendor's own PDF (document store). */
export const invoices = pgTable(
  'invoices',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    vendorJobId: uuid('vendor_job_id').references(() => vendorJobs.id, { onDelete: 'set null' }),
    status: invoiceStatusEnum('status').notNull().default('received'),
    invoiceNumber: text('invoice_number').notNull(),
    issuedAt: isoDate('issued_at').notNull(),
    dueDate: isoDate('due_date'),
    amountFils: integer('amount_fils').notNull(),
    vatFils: integer('vat_fils').notNull().default(0),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('invoices_org_vendor_number_uq').on(t.organizationId, t.vendorId, t.invoiceNumber),
    index('invoices_org_status_idx').on(t.organizationId, t.status),
    check('invoices_amount_ck', sql`${t.amountFils} >= 0 AND ${t.vatFils} >= 0`),
  ],
);

/** M6 — periodic vendor scorecard (inputs match contracts vendorScoreInputSchema). */
export const performanceScores = pgTable(
  'performance_scores',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    asOf: isoDate('as_of').notNull(),
    jobsTotal: integer('jobs_total').notNull().default(0),
    jobsCompleted: integer('jobs_completed').notNull().default(0),
    jobsOnTime: integer('jobs_on_time').notNull().default(0),
    costVarianceBpsSum: integer('cost_variance_bps_sum').notNull().default(0),
    jobsReworked: integer('jobs_reworked').notNull().default(0),
    score: numeric('score', { precision: 5, scale: 2 }),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('performance_scores_vendor_asof_uq').on(t.vendorId, t.asOf),
    index('performance_scores_org_idx').on(t.organizationId),
    check(
      'performance_scores_counts_ck',
      sql`${t.jobsTotal} >= 0 AND ${t.jobsCompleted} >= 0 AND ${t.jobsOnTime} >= 0 AND ${t.jobsReworked} >= 0`,
    ),
    check('performance_scores_subset_ck', sql`${t.jobsCompleted} <= ${t.jobsTotal}`),
  ],
);
