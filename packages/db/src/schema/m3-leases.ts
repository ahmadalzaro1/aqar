import type { EscalationRule, LateFeeRule } from '@aqar/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, isoDate, pkId } from './common.js';
import { leaseStatusEnum, noticeDirectionEnum, noticeKindEnum, offerStatusEnum } from './enums.js';
import { users } from './auth.js';
import { organizations } from './organizations.js';
import { properties, units } from './m1-property.js';

/** M3 — the renting party. May be linked to a login user (tenant portal). */
export const tenants = pgTable(
  'tenants',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fullNameEn: text('full_name_en').notNull(),
    fullNameAr: text('full_name_ar').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    /** National id / passport is stored hashed, never in clear text. */
    nationalIdHash: text('national_id_hash'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('tenants_org_idx').on(t.organizationId),
    index('tenants_email_idx').on(t.email),
    uniqueIndex('tenants_org_phone_uq').on(t.organizationId, t.phone),
    check('tenants_phone_ck', sql`length(btrim(${t.phone})) >= 7`),
  ],
);

/**
 * M3 — the lease. Money is fils, due day is capped at 28 so no month-length
 * edge cases exist in proration/late-fee math (contracts leaseMoneyTermsSchema).
 */
export const leases = pgTable(
  'leases',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    status: leaseStatusEnum('status').notNull().default('upcoming'),
    startDate: isoDate('start_date').notNull(),
    endDate: isoDate('end_date').notNull(),
    rentFils: integer('rent_fils').notNull(),
    depositFils: integer('deposit_fils').notNull(),
    dueDay: integer('due_day').notNull(),
    lateFeeRule: jsonb('late_fee_rule').$type<LateFeeRule>(),
    escalationRule: jsonb('escalation_rule')
      .$type<EscalationRule>()
      .notNull()
      .default(sql`'{"kind":"none"}'::jsonb`),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    terminatedAt: timestamp('terminated_at', { withTimezone: true }),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('leases_org_idx').on(t.organizationId),
    index('leases_unit_idx').on(t.unitId),
    index('leases_org_status_idx').on(t.organizationId, t.status),
    index('leases_org_end_idx').on(t.organizationId, t.endDate),
    check('leases_due_day_ck', sql`${t.dueDay} BETWEEN 1 AND 28`),
    check('leases_rent_ck', sql`${t.rentFils} >= 0`),
    check('leases_deposit_ck', sql`${t.depositFils} >= 0`),
    check('leases_dates_ck', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/** M3 — co-tenants: a lease may have many tenants; exactly one should be primary. */
export const leaseTenants = pgTable(
  'lease_tenants',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    /** Share of the rent obligation in basis points, when co-tenants split. */
    shareBps: integer('share_bps').notNull().default(10000),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('lease_tenants_lease_tenant_uq').on(t.leaseId, t.tenantId),
    index('lease_tenants_org_idx').on(t.organizationId),
    index('lease_tenants_tenant_idx').on(t.tenantId),
    check('lease_tenants_share_bps_ck', sql`${t.shareBps} BETWEEN 0 AND 10000`),
  ],
);

export const leaseAddendums = pgTable(
  'lease_addendums',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    effectiveDate: isoDate('effective_date').notNull(),
    summaryEn: text('summary_en').notNull(),
    summaryAr: text('summary_ar').notNull(),
    bodyMd: text('body_md'),
    /** Rent after the addendum, when the addendum changes money. */
    rentFils: integer('rent_fils'),
    documentKey: text('document_key'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('lease_addendums_org_idx').on(t.organizationId),
    index('lease_addendums_lease_idx').on(t.leaseId),
    check('lease_addendums_rent_ck', sql`${t.rentFils} IS NULL OR ${t.rentFils} >= 0`),
  ],
);

export const renewalOffers = pgTable(
  'renewal_offers',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    status: offerStatusEnum('status').notNull().default('draft'),
    offeredRentFils: integer('offered_rent_fils').notNull(),
    startDate: isoDate('start_date').notNull(),
    endDate: isoDate('end_date').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('renewal_offers_org_idx').on(t.organizationId),
    index('renewal_offers_lease_idx').on(t.leaseId),
    check('renewal_offers_rent_ck', sql`${t.offeredRentFils} >= 0`),
    check('renewal_offers_dates_ck', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/** M3 — served notice (rent increase, entry, termination). Content is versioned text. */
export const notices = pgTable(
  'notices',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id').references(() => leases.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    kind: noticeKindEnum('kind').notNull(),
    direction: noticeDirectionEnum('direction').notNull().default('to_tenant'),
    servedAt: timestamp('served_at', { withTimezone: true }).notNull(),
    /** 'whatsapp' | 'email' | 'hand' | 'registered_mail' — free text, not an enum */
    method: text('method').notNull(),
    bodyMd: text('body_md').notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('notices_org_idx').on(t.organizationId),
    index('notices_lease_idx').on(t.leaseId),
    index('notices_served_idx').on(t.organizationId, t.servedAt),
    check('notices_target_ck', sql`${t.leaseId} IS NOT NULL OR ${t.tenantId} IS NOT NULL`),
  ],
);
