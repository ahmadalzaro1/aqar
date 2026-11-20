import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { emergencyPrecheck } from '@aqar/core';
import { ticketIngestJobSchema, type TicketIngestJob } from '@aqar/contracts';
import type { ToolContext } from '../context.js';
import { canWrite } from '../env.js';
import { ToolError } from '../errors.js';
import { gate } from '../gate.js';
import { recordAudit } from '../audit.js';
import { deterministicId } from '../ids.js';
import { createProposal } from '../proposals.js';
import { enqueueTriage, type EnqueueOutcome } from '../queue.js';
import { ok } from '../result.js';

const localeSchema = z.enum(['ar', 'en']);

export function registerTicketTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_open_tickets',
    {
      title: 'Open maintenance tickets',
      description:
        'Open tickets with severity, emergency flag and age. Emergencies first. Use for "what is broken" and "what needs attention" questions.',
      inputSchema: {
        propertyId: z.string().uuid().optional(),
        emergencyOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ propertyId, emergencyOnly, limit }) => {
      const rows = await ctx.sql<{
        id: string; subject: string; status: string; channel: string; emergencyFlag: boolean;
        openedAt: Date; ageHours: number; property: string | null; unitNumber: string | null;
        tenant: string | null; category: string | null; severity: string | null;
      }[]>`
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
         order by t.emergency_flag desc, t.opened_at asc
         limit ${limit}
      `;

      return ok({
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
      });
    },
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Ticket detail',
      description:
        'One ticket with its message thread, latest classification, attachments count and whether it was handed to a human.',
      inputSchema: { ticketId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ticketId }) => {
      const tickets = await ctx.sql<{
        id: string; subject: string; body: string; status: string; channel: string;
        locale: string; emergencyFlag: boolean; openedAt: Date; closedAt: Date | null;
        property: string | null; unitNumber: string | null; tenant: string | null; tenantId: string | null;
      }[]>`
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
        throw new ToolError('ticket_not_found', `No ticket ${ticketId} in this organization`);
      }

      const messages = await ctx.sql<{
        direction: string; channel: string; body: string; locale: string; sentAt: Date | null;
      }[]>`
        select direction::text as direction, channel::text as channel, body,
               body_locale::text as locale, sent_at as "sentAt"
          from ticket_messages
         where organization_id = ${ctx.org.id} and ticket_id = ${ticketId}
         order by coalesce(sent_at, created_at) asc
         limit 50
      `;

      const classification = await ctx.sql<{
        category: string; severity: string; emergencyFlag: boolean; confidence: string;
        rationale: string; modelId: string | null; createdAt: Date;
      }[]>`
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

      const traces = await ctx.sql<{ handedOff: boolean; reason: string | null; tokens: number | null }[]>`
        select handed_off_to_human as "handedOff", handoff_reason as reason, total_tokens as tokens
          from agent_traces
         where organization_id = ${ctx.org.id} and ticket_id = ${ticketId}
         order by created_at desc
         limit 1
      `;

      const latest = classification[0];
      return ok({
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
        classification: latest === undefined ? null : {
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
      });
    },
  );

  server.registerTool(
    'create_ticket',
    {
      title: 'Create a maintenance ticket',
      description:
        'File a maintenance ticket. Runs the deterministic emergency pre-check on the text: if it detects gas, fire, sewage, flooding or an electrical hazard the ticket is flagged as an emergency and you MUST relay the returned safety instruction to the person immediately. The emergency flag cannot be removed afterwards.',
      inputSchema: {
        subject: z.string().min(3).max(200),
        body: z.string().min(3).max(4000),
        propertyId: z.string().uuid(),
        unitId: z.string().uuid().optional(),
        tenantId: z.string().uuid().optional(),
        locale: localeSchema.default('en'),
        channel: z.enum(['whatsapp', 'telegram', 'email', 'in_app', 'phone']).default('in_app'),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ subject, body, propertyId, unitId, tenantId, locale, channel, idempotencyKey }) => {
      if (!canWrite(ctx.cfg.mode)) {
        throw new ToolError('read_only_mode', 'This server is in read_only mode', 'Set AQAR_MCP_MODE=propose to file tickets.');
      }

      // LAW 2: the deterministic classifier runs on every ingress path, and a
      // model cannot talk it out of an emergency.
      const precheck = emergencyPrecheck(`${subject}\n${body}`);

      const outcome = await ctx.sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${ctx.org.id}, true)`;

        const decision = await gate(tx, ctx, { action: 'draft_only', propertyId });
        if (!decision.allowed) {
          throw new ToolError('policy_denied', `Policy denied creating the ticket: ${decision.reasons.join(', ')}`);
        }

        const ticketId = idempotencyKey === undefined
          ? randomUUID()
          : deterministicId('aqar.ticket', idempotencyKey);

        const inserted = await tx<{ id: string }[]>`
          insert into tickets (
            id, organization_id, property_id, unit_id, tenant_id,
            channel, status, opened_at, subject, body, body_locale, emergency_flag
          ) values (
            ${ticketId}, ${ctx.org.id}, ${propertyId},
            ${unitId ?? null}, ${tenantId ?? null},
            ${channel}, 'new', ${ctx.now()}, ${subject}, ${body}, ${locale},
            ${precheck.emergency}
          )
          on conflict (id) do nothing
          returning id
        `;

        const created = inserted[0];
        if (created === undefined) {
          return { duplicate: true, ticketId };
        }

        const auditId = await recordAudit(tx, {
          organizationId: ctx.org.id,
          action: 'ticket.created',
          entityType: 'ticket',
          entityId: created.id,
          actor: { kind: 'agent', name: ctx.cfg.actorName, model: ctx.cfg.modelId },
          toolName: 'create_ticket',
          after: { subject, propertyId, unitId: unitId ?? null, tenantId: tenantId ?? null, emergency: precheck.emergency, signals: precheck.signals },
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          occurredAt: ctx.now(),
        });

        return { duplicate: false, ticketId: created.id, auditId };
      });

      if (outcome.duplicate) {
        return ok({
          ok: true,
          duplicate: true,
          ticketId: outcome.ticketId,
          note: 'This exact request was already filed (same idempotency key). Do not file it twice.',
        });
      }

      // Enqueue only after the commit: a job must never point at an uncommitted row.
      let triage: EnqueueOutcome;
      if (ctx.queue === null) {
        triage = { enqueued: false, error: 'triage queue not available (Redis unreachable at boot)' };
      } else {
        const payload: TicketIngestJob = ticketIngestJobSchema.parse({
          ticketId: outcome.ticketId,
          orgId: ctx.org.id,
          channel,
          text: `${subject}\n${body}`,
          locale,
          tenantId: tenantId ?? null,
          idempotencyKey: idempotencyKey === undefined ? `mcp:${outcome.ticketId}` : `mcp:${idempotencyKey}`,
        });
        triage = await enqueueTriage(ctx.queue, payload);
      }

      return ok({
        ok: true,
        duplicate: false,
        ticketId: outcome.ticketId,
        auditId: outcome.auditId,
        emergency: precheck.emergency,
        emergencySignals: precheck.signals,
        safetyInstructionsKey: precheck.safetyInstructionsKey,
        triage,
        instruction: precheck.emergency
          ? 'EMERGENCY. Relay the safety instruction for safetyInstructionsKey to the person now, and tell them a human is being paged. Do not wait, do not ask follow-up questions first.'
          : triage.enqueued
            ? 'Ticket filed and queued for triage. Classification runs in the worker.'
            : 'Ticket filed but NOT queued for triage. Tell the user a human must look at it now.',
      });
    },
  );

  server.registerTool(
    'log_tenant_message',
    {
      title: 'Log an inbound tenant message',
      description:
        'Append a message a tenant sent (e.g. pasted from WhatsApp) to a ticket thread. Records only; sends nothing.',
      inputSchema: {
        ticketId: z.string().uuid(),
        body: z.string().min(1).max(4000),
        locale: localeSchema.default('ar'),
        channel: z.enum(['whatsapp', 'telegram', 'email', 'in_app', 'phone']).default('whatsapp'),
        externalId: z.string().min(1).max(200).optional().describe('Provider message id, for dedupe'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ ticketId, body, locale, channel, externalId }) => {
      if (!canWrite(ctx.cfg.mode)) {
        throw new ToolError('read_only_mode', 'This server is in read_only mode');
      }

      return ctx.sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${ctx.org.id}, true)`;

        const ticketRows = await tx<{ id: string; propertyId: string | null; tenantId: string | null }[]>`
          select id, property_id as "propertyId", tenant_id as "tenantId"
            from tickets
           where organization_id = ${ctx.org.id} and id = ${ticketId}
           limit 1
        `;
        const ticket = ticketRows[0];
        if (ticket === undefined) {
          throw new ToolError('ticket_not_found', `No ticket ${ticketId} in this organization`);
        }

        const messageId = externalId === undefined
          ? randomUUID()
          : deterministicId('aqar.ticket_message', externalId);

        const inserted = await tx<{ id: string }[]>`
          insert into ticket_messages (
            id, organization_id, ticket_id, direction, channel, tenant_id,
            body, body_locale, sent_at, external_id
          ) values (
            ${messageId}, ${ctx.org.id}, ${ticketId}, 'inbound', ${channel},
            ${ticket.tenantId}, ${body}, ${locale}, ${ctx.now()}, ${externalId ?? null}
          )
          on conflict (id) do nothing
          returning id
        `;

        if (inserted[0] === undefined) {
          return ok({ ok: true, duplicate: true, messageId });
        }

        const auditId = await recordAudit(tx, {
          organizationId: ctx.org.id,
          action: 'ticket.message.logged',
          entityType: 'ticket_message',
          entityId: messageId,
          actor: { kind: 'agent', name: ctx.cfg.actorName, model: ctx.cfg.modelId },
          toolName: 'log_tenant_message',
          after: { ticketId, channel, locale, externalId: externalId ?? null },
          ...(externalId === undefined ? {} : { idempotencyKey: externalId }),
          occurredAt: ctx.now(),
        });

        return ok({ ok: true, duplicate: false, messageId, auditId });
      });
    },
  );

  server.registerTool(
    'propose_tenant_reply',
    {
      title: 'Propose a reply to a tenant',
      description:
        'File a proposed outbound message to a tenant for human approval. Nothing is sent: WhatsApp/Telegram delivery happens only after a human approves in the console, because tenant contact is capped and quiet-hours bound.',
      inputSchema: {
        ticketId: z.string().uuid(),
        body: z.string().min(1).max(2000),
        locale: localeSchema.default('ar'),
        propertyId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ ticketId, body, locale, propertyId }) => {
      if (!canWrite(ctx.cfg.mode)) {
        throw new ToolError('read_only_mode', 'This server is in read_only mode');
      }

      return ctx.sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${ctx.org.id}, true)`;

        const ticketRows = await tx<{ id: string; propertyId: string | null; tenant: string | null; subject: string }[]>`
          select t.id, t.property_id as "propertyId", t.subject,
                 coalesce(tn.full_name_en, tn.full_name_ar) as tenant
            from tickets t
            left join tenants tn on tn.id = t.tenant_id
           where t.organization_id = ${ctx.org.id} and t.id = ${ticketId}
           limit 1
        `;
        const ticket = ticketRows[0];
        if (ticket === undefined) {
          throw new ToolError('ticket_not_found', `No ticket ${ticketId} in this organization`);
        }

        const targetProperty = propertyId ?? ticket.propertyId;
        if (targetProperty === null) {
          throw new ToolError('property_required', 'The ticket has no property, so policy cannot be evaluated', 'Pass propertyId explicitly.');
        }

        const proposal = await createProposal(tx, ctx, {
          toolName: 'propose_tenant_reply',
          action: 'send_tenant_message',
          propertyId: targetProperty,
          args: { ticketId, body, locale },
          summary: `Reply to ${ticket.tenant ?? 'tenant'} about "${ticket.subject}"`,
        });

        return ok({
          ok: true,
          proposalId: proposal.proposalId,
          duplicate: proposal.duplicate,
          expiresAt: proposal.expiresAt,
          sent: false,
          policy: {
            allowedNow: proposal.policy.allowed,
            requiresHumanApproval: proposal.policy.requiresHumanApproval,
            reasons: proposal.policy.reasons,
          },
          note: 'Nothing was sent. A human approves this in the console; delivery then goes through the channels service.',
        });
      });
    },
  );
}
