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
import {
  applicationDecisionEnum,
  applicationStatusEnum,
  inquiryStatusEnum,
  listingStatusEnum,
  showingOutcomeEnum,
  ticketChannelEnum,
} from './enums.js';
import { users } from './auth.js';
import { organizations } from './organizations.js';
import { properties, units } from './m1-property.js';

/** M2 — a unit offered for rent. */
export const listings = pgTable(
  'listings',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'cascade' }),
    status: listingStatusEnum('status').notNull().default('draft'),
    channel: ticketChannelEnum('channel').notNull().default('in_app'),
    titleEn: text('title_en').notNull(),
    titleAr: text('title_ar').notNull(),
    descriptionEn: text('description_en'),
    descriptionAr: text('description_ar'),
    rentAskFils: integer('rent_ask_fils').notNull(),
    depositAskFils: integer('deposit_ask_fils').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('listings_org_idx').on(t.organizationId),
    index('listings_unit_idx').on(t.unitId),
    index('listings_status_idx').on(t.organizationId, t.status),
    check('listings_rent_ck', sql`${t.rentAskFils} >= 0 AND ${t.depositAskFils} >= 0`),
  ],
);

export const inquiries = pgTable(
  'inquiries',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'set null' }),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    phone: text('phone').notNull(),
    email: text('email'),
    channel: ticketChannelEnum('channel').notNull(),
    message: text('message'),
    status: inquiryStatusEnum('status').notNull().default('new'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('inquiries_org_idx').on(t.organizationId),
    index('inquiries_listing_idx').on(t.listingId),
    index('inquiries_status_idx').on(t.organizationId, t.status),
  ],
);

export const showings = pgTable(
  'showings',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    inquiryId: uuid('inquiry_id').references(() => inquiries.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'cascade' }),
    agentUserId: uuid('agent_user_id').references(() => users.id, { onDelete: 'set null' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    outcome: showingOutcomeEnum('outcome').notNull().default('scheduled'),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('showings_org_idx').on(t.organizationId),
    index('showings_unit_idx').on(t.unitId),
    index('showings_scheduled_idx').on(t.organizationId, t.scheduledAt),
  ],
);

/** M2 — a prospective tenant. National id is stored hashed only. */
export const applicants = pgTable(
  'applicants',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fullNameEn: text('full_name_en').notNull(),
    fullNameAr: text('full_name_ar'),
    phone: text('phone').notNull(),
    email: text('email'),
    nationalIdHash: text('national_id_hash'),
    employer: text('employer'),
    monthlyIncomeFils: integer('monthly_income_fils'),
    householdSize: integer('household_size').notNull().default(1),
    ...auditTimestamps(),
  },
  (t) => [
    index('applicants_org_idx').on(t.organizationId),
    index('applicants_email_idx').on(t.email),
    check(
      'applicants_income_ck',
      sql`${t.monthlyIncomeFils} IS NULL OR ${t.monthlyIncomeFils} >= 0`,
    ),
    check('applicants_household_ck', sql`${t.householdSize} > 0`),
  ],
);

export const applications = pgTable(
  'applications',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    applicantId: uuid('applicant_id')
      .notNull()
      .references(() => applicants.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'set null' }),
    status: applicationStatusEnum('status').notNull().default('received'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    desiredStartDate: isoDate('desired_start_date'),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('applications_org_idx').on(t.organizationId),
    index('applications_unit_idx').on(t.unitId),
    index('applications_status_idx').on(t.organizationId, t.status),
  ],
);

/** M2 — screening run output. Provider and raw payload kept for auditability. */
export const screeningResults = pgTable(
  'screening_results',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    score: integer('score'),
    passed: boolean('passed').notNull(),
    details: jsonb('details')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('screening_results_org_idx').on(t.organizationId),
    index('screening_results_application_idx').on(t.applicationId),
    uniqueIndex('screening_results_application_kind_uq').on(t.applicationId, t.kind),
    check(
      'screening_results_score_ck',
      sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 100)`,
    ),
  ],
);

/** M2 — final human decision. Reason is mandatory; the approver is mandatory. */
export const decisions = pgTable(
  'decisions',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    decision: applicationDecisionEnum('decision').notNull(),
    reason: text('reason').notNull(),
    decidedByUserId: uuid('decided_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('decisions_org_idx').on(t.organizationId),
    uniqueIndex('decisions_application_uq').on(t.applicationId),
    check('decisions_reason_ck', sql`length(btrim(${t.reason})) > 0`),
  ],
);
