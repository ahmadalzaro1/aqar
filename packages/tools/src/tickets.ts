/**
 * Ticket read tools — the open-ticket queue and one ticket's full thread.
 *
 * The SQL lives here, once. Filing and logging stay in the MCP adapter for now:
 * they queue work and write audit rows, which the transport owns.
 */
import { z } from 'zod';
import { ToolFailure } from './errors.js';
import type { ToolDef } from './registry.js';

export const listOpenTicketsSchema = z.object({
  propertyId: z.string().uuid().optional(),
  emergencyOnly: z.boolean().default(false),
  /** Server-side age filter: the model must not compare timestamps itself. */
  olderThanHours: z.number().int().min(1).max(8760).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const listOpenTickets: ToolDef = {
  name: 'list_open_tickets',
  kind: 'read',
  title: 'Open maintenance tickets',
  description:
    'Open tickets with severity, emergency flag and age. Emergencies first. Use for "what is broken" and "what needs attention" questions. Pass olderThanHours to filter by age (e.g. 168 for "older than a week") — never compare timestamps yourself.',
  schema: listOpenTicketsSchema,
  async run(ctx, raw) {
    const { propertyId, emergencyOnly, olderThanHours, limit } = listOpenTicketsSchema.parse(raw);
    const rows = await ctx.sql<
      {
        id: string;
        subject: string;
        status: string;
        channel: string;
        emergencyFlag: boolean;
        openedAt: Date;
        ageHours: number;
        property: string | null;
        unitNumber: string | null;
        tenant: string | null;
        category: string | null;
        severity: string | null;
      }[]
    >`
      select t.id,
             t.subject,
             t.status::text as status,
             t.channel::text as channel,
             t.emergency_flag as "emergencyFlag",
             t.opened_at as "openedAt",
             floor(extract(epoch from (now() - t.opened_at)) / 3600)::int as "ageHours",
             p.name as property,
             u.unit_number as "unitNumber",
             coalesce(tn.full_name_en, tn.full_name_ar) as tenant,
             c.category::text as category,
             c.severity::text as severity
        from tickets t
        left join properties p on p.id = t.property_id
        left join units u on u.id = t.unit_id
        left join tenants tn on tn.id = t.tenant_id
        left join lateral (
          select category, severity from classifications cl
           where cl.ticket_id = t.id order by cl.created_at desc limit 1
        ) c on true
       where t.organization_id = ${ctx.org.id}
         and t.status not in ('closed', 'cancelled')
         and (${propertyId ?? null}::uuid is null or t.property_id = ${propertyId ?? null}::uuid)
         and (${emergencyOnly} = false or t.emergency_flag = true)
         and (${olderThanHours ?? null}::int is null
              or t.opened_at <= now() - (${olderThanHours ?? null}::int * interval '1 hour'))
       order by t.emergency_flag desc, t.opened_at asc
       limit ${limit}
    `;

    return {
      count: rows.length,
      tickets: rows.map((row) => ({
        ticketId: row.id,
        subject: row.subject,
        status: row.status,
        channel: row.channel,
        emergency: row.emergencyFlag,
        severity: row.severity,
        category: row.category,
        property: row.property,
        unitNumber: row.unitNumber,
        tenant: row.tenant,
        openedAt: row.openedAt.toISOString(),
        ageHours: row.ageHours,
      })),
    };
  },
};

export const getTicketSchema = z.object({ ticketId: z.string().uuid() });

export const getTicket: ToolDef = {
  name: 'get_ticket',
  kind: 'read',
  title: 'Ticket detail',
  description:
    'One ticket with its message thread, latest classification, attachments count and whether it was handed to a human.',
  schema: getTicketSchema,
  async run(ctx, raw) {
    const { ticketId } = getTicketSchema.parse(raw);

    const tickets = await ctx.sql<
      {
        id: string;
        subject: string;
        body: string;
        status: string;
        channel: string;
        locale: string;
        emergencyFlag: boolean;
        openedAt: Date;
        closedAt: Date | null;
        property: string | null;
        unitNumber: string | null;
        tenant: string | null;
        tenantId: string | null;
      }[]
    >`
      select t.id, t.subject, t.body, t.status::text as status, t.channel::text as channel,
             t.body_locale::text as locale, t.emergency_flag as "emergencyFlag",
             t.opened_at as "openedAt", t.closed_at as "closedAt",
             p.name as property, u.unit_number as "unitNumber",
             coalesce(tn.full_name_en, tn.full_name_ar) as tenant, tn.id as "tenantId"
        from tickets t
        left join properties p on p.id = t.property_id
        left join units u on u.id = t.unit_id
        left join tenants tn on tn.id = t.tenant_id
       where t.organization_id = ${ctx.org.id} and t.id = ${ticketId}
       limit 1
    `;
    const ticket = tickets[0];
    if (ticket === undefined) {
      throw new ToolFailure('ticket_not_found', `No ticket ${ticketId} in this organization`);
    }

    const messages = await ctx.sql<
      {
        direction: string;
        channel: string;
        body: string;
        locale: string;
        sentAt: Date | null;
      }[]
    >`
      select direction::text as direction, channel::text as channel, body,
             body_locale::text as locale, sent_at as "sentAt"
        from ticket_messages
       where organization_id = ${ctx.org.id} and ticket_id = ${ticketId}
       order by coalesce(sent_at, created_at) asc
       limit 50
    `;

    const classification = await ctx.sql<
      {
        category: string;
        severity: string;
        emergencyFlag: boolean;
        confidence: string;
        rationale: string;
        modelId: string | null;
        createdAt: Date;
      }[]
    >`
      select category::text as category, severity::text as severity,
             emergency_flag as "emergencyFlag", confidence::text as confidence,
             rationale, model_id as "modelId", created_at as "createdAt"
        from classifications
       where organization_id = ${ctx.org.id} and ticket_id = ${ticketId}
       order by created_at desc
       limit 1
    `;

    const attachments = await ctx.sql<{ count: string }[]>`
      select count(*)::text as count from attachments
       where organization_id = ${ctx.org.id} and ticket_id = ${ticketId}
    `;

    const traces = await ctx.sql<
      { handedOff: boolean; reason: string | null; tokens: number | null }[]
    >`
      select handed_off_to_human as "handedOff", handoff_reason as reason, total_tokens as tokens
        from agent_traces
       where organization_id = ${ctx.org.id} and ticket_id = ${ticketId}
       order by created_at desc
       limit 1
    `;

    const latest = classification[0];
    return {
      ticket: {
        ticketId: ticket.id,
        subject: ticket.subject,
        body: ticket.body,
        status: ticket.status,
        channel: ticket.channel,
        locale: ticket.locale,
        emergency: ticket.emergencyFlag,
        openedAt: ticket.openedAt.toISOString(),
        closedAt: ticket.closedAt === null ? null : ticket.closedAt.toISOString(),
        property: ticket.property,
        unitNumber: ticket.unitNumber,
        tenant: ticket.tenant,
        tenantId: ticket.tenantId,
      },
      classification:
        latest === undefined
          ? null
          : {
              category: latest.category,
              severity: latest.severity,
              emergency: latest.emergencyFlag,
              confidence: Number(latest.confidence),
              rationale: latest.rationale,
              modelId: latest.modelId,
              at: latest.createdAt.toISOString(),
            },
      attachmentCount: Number(attachments[0]?.count ?? '0'),
      handoff: traces[0] === undefined ? null : traces[0],
      messages: messages.map((message) => ({
        direction: message.direction,
        channel: message.channel,
        locale: message.locale,
        sentAt: message.sentAt === null ? null : message.sentAt.toISOString(),
        body: message.body,
      })),
    };
  },
};

export const ticketsTools = [listOpenTickets, getTicket] as const;
