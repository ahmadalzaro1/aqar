import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, isoDate, pkId } from './common.js';
import {
  accountCodeEnum,
  chargeKindEnum,
  chequeStatusEnum,
  matchKindEnum,
  paymentMethodEnum,
} from './enums.js';
import type { LateFeeRule } from '@aqar/contracts';
import { organizations } from './organizations.js';
import { leases, tenants } from './m3-leases.js';

/** Billing period guard used by charges/payments/journal_lines. */
const periodFormat = (column: string) => sql`${sql.raw(`"${column}"`)} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`;

/**
 * M4 — a charge on a lease for a billing period.
 * Status is NOT stored: it is derived from allocations
 * ('open' | 'partial' | 'paid' | 'overdue'), per contracts chargeStatusSchema.
 */
export const charges = pgTable(
  'charges',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    kind: chargeKindEnum('kind').notNull(),
    amountFils: integer('amount_fils').notNull(),
    dueDate: isoDate('due_date').notNull(),
    /** set on prorated first/last periods; informational only. */
    proratedDays: integer('prorated_days'),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('charges_lease_period_kind_uq').on(t.leaseId, t.period, t.kind),
    index('charges_org_period_idx').on(t.organizationId, t.period),
    index('charges_lease_idx').on(t.leaseId),
    check('charges_period_format_ck', periodFormat('period')),
    check('charges_amount_ck', sql`${t.amountFils} >= 0`),
    check('charges_prorated_ck', sql`${t.proratedDays} IS NULL OR ${t.proratedDays} >= 0`),
  ],
);

/** M4 — money received. `reference_period` is only ever set by a human confirmation. */
export const payments = pgTable(
  'payments',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    payerId: uuid('payer_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    amountFils: integer('amount_fils').notNull(),
    receivedDate: isoDate('received_date').notNull(),
    method: paymentMethodEnum('method').notNull(),
    referencePeriod: text('reference_period'),
    referenceText: text('reference_text'),
    chequeStatus: chequeStatusEnum('cheque_status'),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('payments_org_received_idx').on(t.organizationId, t.receivedDate),
    index('payments_payer_idx').on(t.payerId),
    check('payments_amount_ck', sql`${t.amountFils} > 0`),
    check(
      'payments_reference_period_ck',
      sql`${t.referencePeriod} IS NULL OR ${t.referencePeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    // a cheque must carry its own instrument status, and only a cheque may.
    check(
      'payments_cheque_status_ck',
      sql`(${t.method} = 'cheque' AND ${t.chequeStatus} IS NOT NULL) OR (${t.method} <> 'cheque' AND ${t.chequeStatus} IS NULL)`,
    ),
  ],
);

/** M4 — allocation of received money to charges. Positive amounts only. */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    chargeId: uuid('charge_id')
      .notNull()
      .references(() => charges.id, { onDelete: 'restrict' }),
    amountFils: integer('amount_fils').notNull(),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('payment_allocations_payment_charge_uq').on(t.paymentId, t.chargeId),
    index('payment_allocations_org_idx').on(t.organizationId),
    index('payment_allocations_charge_idx').on(t.chargeId),
    check('payment_allocations_amount_ck', sql`${t.amountFils} > 0`),
  ],
);

/** M4 — an imported bank statement file. */
export const bankImports = pgTable(
  'bank_imports',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountLabel: text('account_label').notNull(),
    bankName: text('bank_name'),
    fileName: text('file_name').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull(),
    lineCount: integer('line_count').notNull().default(0),
    /** hash of the raw file, so a re-upload is detected before parsing. */
    sourceHash: text('source_hash').notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('bank_imports_org_idx').on(t.organizationId),
    uniqueIndex('bank_imports_org_source_hash_uq').on(t.organizationId, t.sourceHash),
    check('bank_imports_line_count_ck', sql`${t.lineCount} >= 0`),
  ],
);

/**
 * M4 — one statement line. `fingerprint` (date+amount+payer+reference digest,
 * computed by @aqar/core fingerprintBankLine) is indexed but NOT unique: the
 * same physical transfer legitimately appears in two overlapping statements,
 * and dedupe is a core concern (dedupeBankLines), not a DB constraint.
 */
export const bankLines = pgTable(
  'bank_lines',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankImports.id, { onDelete: 'cascade' }),
    date: isoDate('date').notNull(),
    amountFils: integer('amount_fils').notNull(),
    payerName: text('payer_name').notNull(),
    payerAccount: text('payer_account'),
    reference: text('reference'),
    fingerprint: text('fingerprint').notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('bank_lines_statement_fingerprint_uq').on(t.statementId, t.fingerprint),
    index('bank_lines_org_fingerprint_idx').on(t.organizationId, t.fingerprint),
    index('bank_lines_statement_idx').on(t.statementId),
    check('bank_lines_amount_ck', sql`${t.amountFils} <> 0`),
  ],
);

/** M4 — proposed match for a bank line. reason is mandatory: always shown to a human. */
export const matchSuggestions = pgTable(
  'match_suggestions',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    bankLineId: uuid('bank_line_id')
      .notNull()
      .references(() => bankLines.id, { onDelete: 'cascade' }),
    kind: matchKindEnum('kind').notNull(),
    /** candidate lease ids, best first; empty for unknown_payer */
    leaseIds: jsonb('lease_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    payerId: uuid('payer_id').references(() => tenants.id, { onDelete: 'set null' }),
    amountFils: integer('amount_fils').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    reason: text('reason').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('match_suggestions_org_idx').on(t.organizationId),
    index('match_suggestions_bank_line_idx').on(t.bankLineId),
    check('match_suggestions_amount_ck', sql`${t.amountFils} >= 0`),
    check(
      'match_suggestions_confidence_ck',
      sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
    ),
    check('match_suggestions_reason_ck', sql`length(btrim(${t.reason})) > 0`),
  ],
);

export const lateFees = pgTable(
  'late_fees',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    chargeId: uuid('charge_id')
      .notNull()
      .references(() => charges.id, { onDelete: 'cascade' }),
    /** the rule snapshot that produced this fee — rules change over time */
    rule: jsonb('rule').$type<LateFeeRule>().notNull(),
    computedFils: integer('computed_fils').notNull(),
    waivedFils: integer('waived_fils').notNull().default(0),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('late_fees_org_idx').on(t.organizationId),
    index('late_fees_charge_idx').on(t.chargeId),
    check('late_fees_computed_ck', sql`${t.computedFils} >= 0`),
    check('late_fees_waived_ck', sql`${t.waivedFils} >= 0 AND ${t.waivedFils} <= ${t.computedFils}`),
  ],
);

export const creditNotes = pgTable(
  'credit_notes',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    amountFils: integer('amount_fils').notNull(),
    period: text('period').notNull(),
    reason: text('reason').notNull(),
    appliedToChargeId: uuid('applied_to_charge_id').references(() => charges.id, {
      onDelete: 'set null',
    }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('credit_notes_org_idx').on(t.organizationId),
    index('credit_notes_tenant_idx').on(t.tenantId),
    check('credit_notes_amount_ck', sql`${t.amountFils} > 0`),
    check('credit_notes_period_ck', periodFormat('period')),
  ],
);

/** M4 — chart of accounts, one row per contracts accountCodeSchema member. */
export const accounts = pgTable(
  'accounts',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: accountCodeEnum('code').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('accounts_org_code_uq').on(t.organizationId, t.code),
    index('accounts_org_idx').on(t.organizationId),
  ],
);

/** M4 — journal entry header. `posted` triggers the balance check. */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entryDate: isoDate('entry_date').notNull(),
    period: text('period').notNull(),
    memo: text('memo').notNull(),
    posted: boolean('posted').notNull().default(false),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('journal_entries_org_period_idx').on(t.organizationId, t.period),
    index('journal_entries_org_posted_idx').on(t.organizationId, t.posted),
    uniqueIndex('journal_entries_source_uq').on(t.organizationId, t.sourceType, t.sourceId),
    check('journal_entries_period_ck', periodFormat('period')),
  ],
);

/** M4 — journal lines. Exactly one of debit/credit is positive. */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    accountCode: accountCodeEnum('account_code').notNull(),
    debitFils: integer('debit_fils').notNull().default(0),
    creditFils: integer('credit_fils').notNull().default(0),
    memo: text('memo').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    period: text('period').notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('journal_lines_entry_idx').on(t.entryId),
    index('journal_lines_org_period_idx').on(t.organizationId, t.period),
    check('journal_lines_debit_ck', sql`${t.debitFils} >= 0`),
    check('journal_lines_credit_ck', sql`${t.creditFils} >= 0`),
    check(
      'journal_lines_one_sided_ck',
      sql`(${t.debitFils} > 0 AND ${t.creditFils} = 0) OR (${t.creditFils} > 0 AND ${t.debitFils} = 0)`,
    ),
    check('journal_lines_period_ck', periodFormat('period')),
  ],
);

/** M4 — closed accounting period. Inserts/updates into it are rejected by trigger. */
export const periodLocks = pgTable(
  'period_locks',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    reason: text('reason').notNull(),
    lockedByUserId: uuid('locked_by_user_id'),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('period_locks_org_period_uq').on(t.organizationId, t.period),
    check('period_locks_period_ck', periodFormat('period')),
  ],
);
