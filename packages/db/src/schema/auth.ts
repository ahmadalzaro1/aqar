import type { Actor, AgentTraceStep, ToolCallTrace } from '@aqar/contracts';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
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
import { auditTimestamps, pkId } from './common.js';
import { identityChannelEnum, userRoleEnum } from './enums.js';
import { organizations } from './organizations.js';

/**
 * Auth + audit tables.
 *
 * RLS: these tables are tenant-scoped by organization_id, but login happens
 * before an organization context exists. Their policy therefore allows the
 * org-scoped read *or* an explicit, narrow `app.system_scope = 'auth'` GUC that
 * only the auth service sets on its own connection. Everything else is
 * fail-closed exactly like the rest of the schema.
 */
export const users = pgTable(
  'users',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    /** argon2id PHC string. Never a plaintext or reversible value. */
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    /** TOTP shared secret, null when 2FA is not enrolled. */
    totpSecret: text('totp_secret'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    index('users_org_idx').on(t.organizationId),
    check('users_email_shape_ck', sql`${t.email} LIKE '%@%'`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the session token; the raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_org_idx').on(t.organizationId),
  ],
);

/**
 * External channel identities (WhatsApp number, Telegram id, email) mapped to a
 * tenant and/or a staff user. tenant_id is intentionally a plain uuid: tenants
 * live in M3 and pointing at them here would create an import cycle.
 */
export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    channel: identityChannelEnum('channel').notNull(),
    externalId: text('external_id').notNull(),
    /** M3 tenants.id (no FK: cross-module cycle, validated in the app layer). */
    tenantId: uuid('tenant_id'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    displayName: text('display_name'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    uniqueIndex('channel_identities_channel_external_uq').on(t.channel, t.externalId),
    index('channel_identities_org_idx').on(t.organizationId),
    index('channel_identities_tenant_idx').on(t.tenantId),
  ],
);

export const otpCodes = pgTable(
  'otp_codes',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    identityId: uuid('identity_id').references(() => channelIdentities.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the 6-digit code; never the code itself. */
    codeHash: text('code_hash').notNull(),
    purpose: text('purpose').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('otp_codes_org_idx').on(t.organizationId),
    index('otp_codes_expires_idx').on(t.expiresAt),
    check('otp_codes_attempts_ck', sql`${t.attempts} >= 0`),
  ],
);

/**
 * APPEND-ONLY audit trail (contracts/audit.ts auditEventSchema).
 * A BEFORE UPDATE OR DELETE trigger (migration 0002) raises for everyone,
 * including the table owner. Corrections are new rows with reversal_of set.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    actor: jsonb('actor').$type<Actor>().notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    toolCalls: jsonb('tool_calls')
      .$type<ToolCallTrace[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Unique: retries of the same logical action can never double-write. */
    idempotencyKey: text('idempotency_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Points at the event this row reverses; null for primary events. */
    reversalOf: uuid('reversal_of').references((): AnyPgColumn => auditEvents.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('audit_events_idempotency_uq').on(t.idempotencyKey),
    index('audit_events_org_occurred_idx').on(t.organizationId, t.occurredAt),
    index('audit_events_entity_idx').on(t.entityType, t.entityId),
    check(
      'audit_events_confidence_ck',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  ],
);

/** Agent execution trace (contracts/audit.ts agentTraceSchema). */
export const agentTraces = pgTable(
  'agent_traces',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** M5 tickets.id — plain uuid to keep module imports acyclic. */
    ticketId: uuid('ticket_id'),
    steps: jsonb('steps')
      .$type<AgentTraceStep[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    totalTokens: integer('total_tokens').notNull().default(0),
    totalLatencyMs: integer('total_latency_ms').notNull().default(0),
    handedOffToHuman: boolean('handed_off_to_human').notNull().default(false),
    handoffReason: text('handoff_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_traces_org_idx').on(t.organizationId),
    index('agent_traces_ticket_idx').on(t.ticketId),
    check('agent_traces_tokens_ck', sql`${t.totalTokens} >= 0 AND ${t.totalLatencyMs} >= 0`),
  ],
);
