import type { Severity } from '@aqar/contracts';
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
import { documentStatusEnum, localeEnum, severityEnum } from './enums.js';
import { users } from './auth.js';
import { organizations } from './organizations.js';
import { properties, units } from './m1-property.js';
import { vendors } from './vendors.js';

/**
 * M8 — versioned document record. The bytes live in S3-compatible storage
 * (s3Key); this row is the chain of custody. Exactly one version is `isLatest`.
 */
export const documents = pgTable(
  'documents',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    title: text('title').notNull(),
    status: documentStatusEnum('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    isLatest: boolean('is_latest').notNull().default(true),
    s3Key: text('s3_key').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('documents_entity_version_uq').on(t.entityType, t.entityId, t.version),
    uniqueIndex('documents_s3_key_uq').on(t.s3Key),
    index('documents_org_idx').on(t.organizationId),
    index('documents_entity_idx').on(t.entityType, t.entityId),
    check('documents_version_ck', sql`${t.version} > 0`),
    check('documents_bytes_ck', sql`${t.bytes} > 0`),
  ],
);

export const inspections = pgTable(
  'inspections',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
    /** 'move_in' | 'move_out' | 'annual' | 'safety' — free text by design */
    kind: text('kind').notNull(),
    conductedAt: timestamp('conducted_at', { withTimezone: true }).notNull(),
    inspectorName: text('inspector_name').notNull(),
    findingsMd: text('findings_md'),
    photos: jsonb('photos').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    ...auditTimestamps(),
  },
  (t) => [
    index('inspections_org_idx').on(t.organizationId),
    index('inspections_property_idx').on(t.propertyId),
    index('inspections_unit_idx').on(t.unitId),
  ],
);

export const insurancePolicies = pgTable(
  'insurance_policies',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    policyNumber: text('policy_number').notNull(),
    coverage: text('coverage').notNull(),
    premiumFils: integer('premium_fils').notNull().default(0),
    startDate: isoDate('start_date').notNull(),
    endDate: isoDate('end_date').notNull(),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    ...auditTimestamps(),
  },
  (t) => [
    index('insurance_policies_org_idx').on(t.organizationId),
    index('insurance_policies_property_idx').on(t.propertyId),
    uniqueIndex('insurance_policies_org_provider_number_uq').on(
      t.organizationId,
      t.provider,
      t.policyNumber,
    ),
    check('insurance_policies_premium_ck', sql`${t.premiumFils} >= 0`),
    check('insurance_policies_dates_ck', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/** M8 — licences/certificates attached to a vendor, unit or property. */
export const certifications = pgTable(
  'certifications',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    kind: text('kind').notNull(),
    issuedAt: isoDate('issued_at'),
    expiresAt: isoDate('expires_at'),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    ...auditTimestamps(),
  },
  (t) => [
    index('certifications_org_idx').on(t.organizationId),
    index('certifications_subject_idx').on(t.subjectType, t.subjectId),
    index('certifications_expiry_idx').on(t.organizationId, t.expiresAt),
  ],
);

/** M8 — reusable notice body. `legal_review_required` defaults true and stays advisory-shaped. */
export const noticeTemplates = pgTable(
  'notice_templates',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    locale: localeEnum('locale').notNull().default('ar'),
    bodyMd: text('body_md').notNull(),
    legalReviewRequired: boolean('legal_review_required').notNull().default(true),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('notice_templates_org_code_locale_uq').on(t.organizationId, t.code, t.locale),
    index('notice_templates_org_idx').on(t.organizationId),
  ],
);

/**
 * M8 — a legal/compliance flag on any entity.
 * This product never presents output as legal advice: the row is only ever a
 * "needs a human decision" marker, so human_review_required is CHECKed true.
 */
export const legalFlags = pgTable(
  'legal_flags',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    flag: text('flag').notNull(),
    rationaleMd: text('rationale_md').notNull(),
    humanReviewRequired: boolean('human_review_required').notNull().default(true),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('legal_flags_org_idx').on(t.organizationId),
    index('legal_flags_entity_idx').on(t.entityType, t.entityId),
    check('legal_flags_human_review_ck', sql`${t.humanReviewRequired} = true`),
    check('legal_flags_rationale_ck', sql`length(btrim(${t.rationaleMd})) > 0`),
  ],
);

/**
 * M8 — configurable service-standard pack (contracts serviceStandardSchema).
 * Explicitly NOT law: a policy the manager adopts, with clocks per severity.
 */
export const serviceStandards = pgTable(
  'service_standards',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    propertyClass: text('property_class').notNull(),
    clocks: jsonb('clocks')
      .$type<Partial<Record<Severity, { responseMinutes: number; resolutionMinutes: number }>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    isDefault: boolean('is_default').notNull().default(false),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('service_standards_org_class_uq').on(t.organizationId, t.propertyClass),
    index('service_standards_org_idx').on(t.organizationId),
    check(
      'service_standards_clocks_ck',
      sql`jsonb_typeof(${t.clocks}) = 'object' AND ${t.clocks} ? 'emergency'`,
    ),
  ],
);

export { severityEnum };
