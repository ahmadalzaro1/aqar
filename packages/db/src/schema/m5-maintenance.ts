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
  vector,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, isoDate, pkId } from './common.js';
import {
  decisionActorEnum,
  dispatchStatusEnum,
  localeEnum,
  messageDirectionEnum,
  responsibilityEnum,
  severityEnum,
  ticketCategoryEnum,
  ticketChannelEnum,
  ticketStatusEnum,
  workOrderStatusEnum,
} from './enums.js';
import { users } from './auth.js';
import { organizations } from './organizations.js';
import { properties, units } from './m1-property.js';
import { tenants } from './m3-leases.js';
import { vendors } from './vendors.js';

/**
 * M5 — tenant-reported issue. `emergencyFlag` is sticky: once true it can never
 * be cleared (trigger in migration 0002), because the safety instruction was
 * already shown and the liability already attached.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    channel: ticketChannelEnum('channel').notNull(),
    status: ticketStatusEnum('status').notNull().default('new'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    subject: text('subject'),
    body: text('body').notNull(),
    bodyLocale: localeEnum('body_locale').notNull().default('ar'),
    emergencyFlag: boolean('emergency_flag').notNull().default(false),
    ...auditTimestamps(),
  },
  (t) => [
    index('tickets_org_idx').on(t.organizationId),
    index('tickets_property_idx').on(t.propertyId),
    index('tickets_unit_idx').on(t.unitId),
    index('tickets_tenant_idx').on(t.tenantId),
    index('tickets_org_status_idx').on(t.organizationId, t.status),
    index('tickets_org_opened_idx').on(t.organizationId, t.openedAt),
    // the emergency queue is the hottest query in the product
    index('tickets_emergency_idx')
      .on(t.organizationId, t.openedAt)
      .where(sql`${t.emergencyFlag} = true`),
    check('tickets_body_ck', sql`length(btrim(${t.body})) > 0`),
  ],
);

export const workOrders = pgTable(
  'work_orders',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    status: workOrderStatusEnum('status').notNull().default('draft'),
    scopeMd: text('scope_md').notNull(),
    /** not-to-exceed limit in fils; the agent policy gates on it */
    nteFils: integer('nte_fils'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('work_orders_org_idx').on(t.organizationId),
    index('work_orders_ticket_idx').on(t.ticketId),
    index('work_orders_vendor_idx').on(t.vendorId),
    check('work_orders_nte_ck', sql`${t.nteFils} IS NULL OR ${t.nteFils} >= 0`),
  ],
);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum('direction').notNull(),
    channel: ticketChannelEnum('channel').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    bodyLocale: localeEnum('body_locale').notNull().default('ar'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    externalId: text('external_id'),
    ...auditTimestamps(),
  },
  (t) => [
    index('ticket_messages_ticket_idx').on(t.ticketId, t.sentAt),
    index('ticket_messages_org_idx').on(t.organizationId),
  ],
);

/** M8-ish file references, kept here because tickets are the main producer. */
export const attachments = pgTable(
  'attachments',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    s3Key: text('s3_key').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('attachments_org_idx').on(t.organizationId),
    index('attachments_entity_idx').on(t.entityType, t.entityId),
    uniqueIndex('attachments_s3_key_uq').on(t.s3Key),
    check('attachments_bytes_ck', sql`${t.bytes} > 0`),
  ],
);

/** M5 — classification output. Deterministic and model verdicts are both kept. */
export const classifications = pgTable(
  'classifications',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    category: ticketCategoryEnum('category').notNull(),
    severity: severityEnum('severity').notNull(),
    emergencyFlag: boolean('emergency_flag').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    /** sticky deterministic pre-check result */
    deterministicEmergency: boolean('deterministic_emergency').notNull(),
    /** severity the model proposed, retained even when the merge raised it */
    modelSeverity: severityEnum('model_severity').notNull(),
    rationale: text('rationale').notNull(),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('classifications_ticket_idx').on(t.ticketId),
    index('classifications_org_created_idx').on(t.organizationId, t.createdAt),
    check('classifications_confidence_ck', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check('classifications_rationale_ck', sql`length(btrim(${t.rationale})) > 0`),
  ],
);

export const responsibilities = pgTable(
  'responsibilities',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    responsibility: responsibilityEnum('responsibility').notNull(),
    reasonMd: text('reason_md').notNull(),
    decidedBy: decisionActorEnum('decided_by').notNull(),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    ...auditTimestamps(),
  },
  (t) => [
    index('responsibilities_ticket_idx').on(t.ticketId),
    index('responsibilities_org_idx').on(t.organizationId),
    check('responsibilities_reason_ck', sql`length(btrim(${t.reasonMd})) > 0`),
  ],
);

export const dispatches = pgTable(
  'dispatches',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    status: dispatchStatusEnum('status').notNull().default('offered'),
    offeredAt: timestamp('offered_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    note: text('note'),
    ...auditTimestamps(),
  },
  (t) => [
    index('dispatches_ticket_idx').on(t.ticketId),
    index('dispatches_vendor_idx').on(t.vendorId),
    index('dispatches_org_idx').on(t.organizationId),
  ],
);

export const vendorQuotes = pgTable(
  'vendor_quotes',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    amountFils: integer('amount_fils').notNull(),
    leadTimeDays: integer('lead_time_days'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    selected: boolean('selected').notNull().default(false),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('vendor_quotes_ticket_idx').on(t.ticketId),
    index('vendor_quotes_vendor_idx').on(t.vendorId),
    index('vendor_quotes_org_idx').on(t.organizationId),
    check('vendor_quotes_amount_ck', sql`${t.amountFils} >= 0`),
    check('vendor_quotes_lead_ck', sql`${t.leadTimeDays} IS NULL OR ${t.leadTimeDays} >= 0`),
  ],
);

export const completions = pgTable(
  'completions',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    workOrderId: uuid('work_order_id').references(() => workOrders.id, {
      onDelete: 'set null',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    costFils: integer('cost_fils').notNull(),
    notes: text('notes'),
    tenantConfirmed: boolean('tenant_confirmed').notNull().default(false),
    photos: jsonb('photos')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...auditTimestamps(),
  },
  (t) => [
    index('completions_ticket_idx').on(t.ticketId),
    index('completions_org_idx').on(t.organizationId),
    check('completions_cost_ck', sql`${t.costFils} >= 0`),
  ],
);

/** M5 — SLA clock snapshot per ticket (response/resolution deadlines in UTC). */
export const slaClocks = pgTable(
  'sla_clocks',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    severity: severityEnum('severity').notNull(),
    responseDueAt: timestamp('response_due_at', { withTimezone: true }).notNull(),
    resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('sla_clocks_ticket_uq').on(t.ticketId),
    index('sla_clocks_org_idx').on(t.organizationId),
    check('sla_clocks_order_ck', sql`${t.resolutionDueAt} >= ${t.responseDueAt}`),
  ],
);

/**
 * M5 — pgvector embeddings for ticket similarity search.
 * Dimension 384 = Xenova/multilingual-e5-small (local ONNX only, never cloud).
 * Indexed with HNSW / cosine distance.
 */
export const ticketEmbeddings = pgTable(
  'ticket_embeddings',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    embedding: vector('embedding', { dimensions: 384 }).notNull(),
    model: text('model').notNull().default('multilingual-e5-small'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ticket_embeddings_ticket_uq').on(t.ticketId),
    index('ticket_embeddings_org_idx').on(t.organizationId),
    index('ticket_embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export { isoDate };
