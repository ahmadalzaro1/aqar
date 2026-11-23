import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { isoDate, pkId } from './common.js';
import { organizations } from './organizations.js';
import { leases } from './m3-leases.js';
import { documents } from './m8-compliance.js';

/**
 * Legal corpus (0020) — reference data shared by every organisation.
 *
 * The answering tools read `legal_reference_citable`, the view that requires a
 * source URL and a reviewer. This table exists so an unreviewed row can be
 * staged without becoming an answer.
 */
export const legalReference = pgTable(
  'legal_reference',
  {
    id: pkId(),
    jurisdiction: text('jurisdiction').notNull().default('JO'),
    instrument: text('instrument').notNull(),
    article: text('article'),
    appliesTo: text('applies_to').notNull(),
    summaryAr: text('summary_ar').notNull(),
    summaryEn: text('summary_en').notNull(),
    verbatimAr: text('verbatim_ar'),
    effectiveFrom: isoDate('effective_from'),
    effectiveTo: isoDate('effective_to'),
    sourceUrl: text('source_url'),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('legal_reference_identity').on(
      t.jurisdiction,
      t.instrument,
      t.article,
      t.appliesTo,
    ),
    index('legal_reference_applies_to_idx').on(t.appliesTo),
  ],
);

/** The clause vocabulary (0021) — eleven keys that carry obligation semantics. */
export const leaseClauseTypes = pgTable(
  'lease_clause_types',
  {
    key: text('key').primaryKey(),
    labelAr: text('label_ar').notNull(),
    labelEn: text('label_en').notNull(),
    obligationAxis: text('obligation_axis').notNull(),
    defaultValue: jsonb('default_value'),
  },
  (t) => [
    check(
      'lease_clause_types_axis_ck',
      sql`${t.obligationAxis} IN ('who_pays','who_decides','timing','amount')`,
    ),
  ],
);

/**
 * What a specific lease says (0021). `extractedBy` + `confidence` decide whether
 * the tool may present a clause as confirmed or must label it parsed.
 */
export const leaseClauses = pgTable(
  'lease_clauses',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    clauseKey: text('clause_key')
      .notNull()
      .references(() => leaseClauseTypes.key),
    value: jsonb('value').$type<Record<string, unknown>>().notNull(),
    textAr: text('text_ar'),
    textEn: text('text_en'),
    documentId: uuid('document_id').references(() => documents.id),
    pageRef: text('page_ref'),
    extractedBy: text('extracted_by'),
    confidence: numeric('confidence'),
    effectiveFrom: isoDate('effective_from'),
  },
  (t) => [
    uniqueIndex('lease_clauses_lease_key_from_key').on(t.leaseId, t.clauseKey, t.effectiveFrom),
    index('lease_clauses_lease_idx').on(t.leaseId),
    index('lease_clauses_org_key_idx').on(t.organizationId, t.clauseKey),
    check(
      'lease_clauses_confidence_check',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  ],
);
