import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, isoDate, pkId } from './common.js';
import { distributionStatusEnum, ownerVoteEnum, spendKindEnum } from './enums.js';
import { users } from './auth.js';
import { organizations } from './organizations.js';
import { properties } from './m1-property.js';
import { workOrders } from './m5-maintenance.js';

/** M7 — a beneficial owner (person or family group). */
export const owners = pgTable(
  'owners',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fullNameEn: text('full_name_en').notNull(),
    fullNameAr: text('full_name_ar').notNull(),
    phone: text('phone'),
    email: text('email'),
    nationalIdHash: text('national_id_hash'),
    bankIban: text('bank_iban'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [index('owners_org_idx').on(t.organizationId), index('owners_email_idx').on(t.email)],
);

/**
 * M7 — ownership split in basis points. Each row is 0..10000; the application
 * layer enforces that the shares of one property sum to exactly 10000
 * (a row-level CHECK cannot see sibling rows).
 */
export const ownershipShares = pgTable(
  'ownership_shares',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    shareBps: integer('share_bps').notNull(),
    effectiveFrom: isoDate('effective_from'),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('ownership_shares_owner_property_uq').on(t.ownerId, t.propertyId),
    index('ownership_shares_org_idx').on(t.organizationId),
    index('ownership_shares_property_idx').on(t.propertyId),
    check('ownership_shares_bps_ck', sql`${t.shareBps} BETWEEN 0 AND 10000`),
  ],
);

export const ownerStatements = pgTable(
  'owner_statements',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    grossRentFils: integer('gross_rent_fils').notNull(),
    expensesFils: integer('expenses_fils').notNull(),
    managementFeeFils: integer('management_fee_fils').notNull().default(0),
    netFils: integer('net_fils').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    documentKey: text('document_key'),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('owner_statements_property_period_uq').on(t.propertyId, t.period),
    index('owner_statements_org_idx').on(t.organizationId),
    check('owner_statements_period_ck', sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      'owner_statements_money_ck',
      sql`${t.grossRentFils} >= 0 AND ${t.expensesFils} >= 0 AND ${t.managementFeeFils} >= 0`,
    ),
  ],
);

export const distributions = pgTable(
  'distributions',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    period: text('period').notNull(),
    amountFils: integer('amount_fils').notNull(),
    status: distributionStatusEnum('status').notNull().default('draft'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('distributions_org_idx').on(t.organizationId),
    index('distributions_owner_idx').on(t.ownerId),
    index('distributions_org_status_idx').on(t.organizationId, t.status),
    check('distributions_amount_ck', sql`${t.amountFils} >= 0`),
    check('distributions_period_ck', sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

export const managementFees = pgTable(
  'management_fees',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    /** fee rate in basis points of collected rent, e.g. 500 = 5% */
    basisBps: integer('basis_bps').notNull(),
    baseFils: integer('base_fils').notNull(),
    feeFils: integer('fee_fils').notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('management_fees_property_period_uq').on(t.propertyId, t.period),
    index('management_fees_org_idx').on(t.organizationId),
    check('management_fees_bps_ck', sql`${t.basisBps} BETWEEN 0 AND 10000`),
    check('management_fees_money_ck', sql`${t.baseFils} >= 0 AND ${t.feeFils} >= 0`),
  ],
);

/**
 * M7 — owner vote. Targets either a distribution or a spend (work order).
 * Exactly one target must be present.
 */
export const ownerApprovals = pgTable(
  'owner_approvals',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    distributionId: uuid('distribution_id').references(() => distributions.id, {
      onDelete: 'cascade',
    }),
    spendId: uuid('spend_id').references(() => workOrders.id, { onDelete: 'cascade' }),
    spendKind: spendKindEnum('spend_kind'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    vote: ownerVoteEnum('vote').notNull(),
    comment: text('comment'),
    votedAt: timestamp('voted_at', { withTimezone: true }).notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('owner_approvals_org_idx').on(t.organizationId),
    index('owner_approvals_distribution_idx').on(t.distributionId),
    index('owner_approvals_spend_idx').on(t.spendId),
    check(
      'owner_approvals_target_ck',
      sql`(${t.distributionId} IS NOT NULL AND ${t.spendId} IS NULL) OR (${t.spendId} IS NOT NULL AND ${t.distributionId} IS NULL)`,
    ),
  ],
);

/** M7 — client-money (trust) bank accounts. Never mixed with operating cash. */
export const trustAccounts = pgTable(
  'trust_accounts',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    bankName: text('bank_name').notNull(),
    iban: text('iban').notNull(),
    currency: text('currency').notNull().default('JOD'),
    openedAt: isoDate('opened_at'),
    isActive: boolean('is_active').notNull().default(true),
    ...auditTimestamps(),
  },
  (t) => [
    index('trust_accounts_org_idx').on(t.organizationId),
    uniqueIndex('trust_accounts_org_iban_uq').on(t.organizationId, t.iban),
  ],
);
