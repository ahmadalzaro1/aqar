import { randomUUID } from 'node:crypto';
import type { Sql } from '@aqar/db';

/**
 * All writes go through a transaction with `app.organization_id` set
 * (`set_config(..., true)`), because every tenant table runs FORCE ROW LEVEL
 * SECURITY with `organization_id = app.current_org_id()`. Same contract as
 * `withOrganization` in @aqar/db, inlined here so each call site owns exactly
 * one transaction.
 */

export type OrgRef = { readonly id: string; readonly slug: string };

export type IdentityChannel = 'whatsapp' | 'telegram' | 'email' | 'in_app';

export type IdentityResult = {
  /** Null when a global (channel, external_id) row exists in another org. */
  readonly id: string | null;
  readonly tenantId: string | null;
};

export type InboundTicketInput = {
  readonly ticketId: string;
  readonly channel: 'whatsapp' | 'telegram';
  readonly subject: string;
  readonly body: string;
  readonly bodyLocale: 'ar' | 'en';
  readonly openedAt: Date;
  readonly tenantId: string | null;
};

export type InsertTicketResult = { readonly id: string; readonly inserted: boolean };

/**
 * Resolves the seeded demo organization by slug. `organizations` is not
 * tenant-scoped (no RLS), so this lookup needs no GUC.
 */
export async function findOrganization(sql: Sql, slug: string): Promise<OrgRef | null> {
  const rows = await sql<{ id: string; slug: string }[]>`
    select id, slug from organizations where slug = ${slug} limit 1
  `;
  const row = rows[0];
  return row === undefined ? null : { id: row.id, slug: row.slug };
}

/**
 * Removes a just-inserted ticket. Only used to compensate when the triage queue
 * is unreachable: leaving a ticket with no job would also make the provider's
 * retry look like a duplicate, silently dropping the message forever.
 */
export async function deleteTicket(
  sql: Sql,
  organizationId: string,
  ticketId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    await tx`delete from tickets where id = ${ticketId} and organization_id = ${organizationId}`;
  });
}

/**
 * Finds or creates the external identity row for a channel handle.
 * (channel, external_id) is globally unique; on a concurrent insert the
 * ON CONFLICT branch returns nothing and we re-read under the org GUC.
 */
export async function ensureChannelIdentity(
  sql: Sql,
  input: {
    readonly organizationId: string;
    readonly channel: IdentityChannel;
    readonly externalId: string;
    readonly displayName: string | null;
  },
): Promise<IdentityResult> {
  const { organizationId, channel, externalId, displayName } = input;
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    const inserted = await tx<{ id: string; tenant_id: string | null }[]>`
      insert into channel_identities (organization_id, channel, external_id, display_name)
      values (${organizationId}, ${channel}::identity_channel, ${externalId}, ${displayName})
      on conflict (channel, external_id) do nothing
      returning id, tenant_id
    `;
    const created = inserted[0];
    if (created !== undefined) return { id: created.id, tenantId: created.tenant_id };

    const existing = await tx<{ id: string; tenant_id: string | null }[]>`
      select id, tenant_id from channel_identities
      where organization_id = ${organizationId}
        and channel = ${channel}::identity_channel
        and external_id = ${externalId}
      limit 1
    `;
    const row = existing[0];
    return row === undefined
      ? { id: null, tenantId: null }
      : { id: row.id, tenantId: row.tenant_id };
  }) as Promise<IdentityResult>;
}

/**
 * Inserts the inbound ticket. The primary key is the deterministic uuid of the
 * idempotency key, so a redelivered provider message conflicts and nothing is
 * written. `emergency_flag` is always false here: the worker's deterministic
 * precheck owns that decision (and the flag is sticky at the DB level).
 */
export async function insertInboundTicket(
  sql: Sql,
  organizationId: string,
  input: InboundTicketInput,
): Promise<InsertTicketResult> {
  const { ticketId, channel, subject, body, bodyLocale, openedAt, tenantId } = input;
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    const propertyId = await tx<{ id: string }[]>`
      select id from properties
      where organization_id = ${organizationId}
      order by created_at asc, id asc
      limit 1
    `;
    const property = propertyId[0];
    if (property === undefined) {
      throw new Error(`organization ${organizationId} has no property to attach a ticket to`);
    }
    const rows = await tx<{ id: string }[]>`
      insert into tickets (
        id, organization_id, property_id, tenant_id, channel, status,
        opened_at, subject, body, body_locale, emergency_flag
      ) values (
        ${ticketId}, ${organizationId}, ${property.id}, ${tenantId},
        ${channel}::ticket_channel, 'new'::ticket_status,
        ${openedAt}, ${subject}, ${body}, ${bodyLocale}::locale, false
      )
      on conflict (id) do nothing
      returning id
    `;
    const insertedRow = rows[0];
    return insertedRow === undefined
      ? { id: ticketId, inserted: false }
      : { id: insertedRow.id, inserted: true };
  }) as Promise<InsertTicketResult>;
}

/**
 * Persists an outbound message on a ticket. Used as the honest fallback when a
 * channel's API credentials are absent, and after a successful API send so the
 * conversation thread stays complete.
 */
export async function insertOutboundMessage(
  sql: Sql,
  input: {
    readonly organizationId: string;
    readonly ticketId: string;
    readonly channel: 'whatsapp' | 'telegram';
    readonly body: string;
    readonly bodyLocale: 'ar' | 'en';
    readonly externalId: string | null;
    readonly sentAt: Date;
  },
): Promise<string> {
  const { organizationId, ticketId, channel, body, bodyLocale, externalId, sentAt } = input;
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    const ticket = await tx<{ id: string }[]>`
      select id from tickets where id = ${ticketId} and organization_id = ${organizationId} limit 1
    `;
    if (ticket[0] === undefined) {
      throw new Error(`ticket ${ticketId} not found in organization ${organizationId}`);
    }
    const id = randomUUID();
    await tx`
      insert into ticket_messages (
        id, organization_id, ticket_id, direction, channel, body, body_locale, sent_at, external_id
      ) values (
        ${id}, ${organizationId}, ${ticketId}, 'outbound'::message_direction,
        ${channel}::ticket_channel, ${body}, ${bodyLocale}::locale, ${sentAt}, ${externalId}
      )
    `;
    return id;
  }) as Promise<string>;
}

export type TicketLookup = {
  readonly id: string;
  readonly organizationId: string;
  readonly locale: 'ar' | 'en';
};
/** Reads a ticket back (used by tests and by outbound callers that need the locale). */
export async function findTicket(
  sql: Sql,
  organizationId: string,
  ticketId: string,
): Promise<TicketLookup | null> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    const rows = await tx<{ id: string; organization_id: string; body_locale: 'ar' | 'en' }[]>`
      select id, organization_id, body_locale from tickets where id = ${ticketId} limit 1
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, organizationId: row.organization_id, locale: row.body_locale };
  }) as Promise<TicketLookup | null>;
}
