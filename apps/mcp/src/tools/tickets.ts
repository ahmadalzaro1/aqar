/**
 * MCP adapter for the ticket tools.
 *
 * Reads (list_open_tickets, get_ticket) are registered straight from
 * `@aqar/tools`, where their SQL lives. Filing, logging and replying stay here:
 * they write, queue triage work and file proposals — transport and policy work
 * the tool core must not carry.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { emergencyPrecheck } from '@aqar/core';
import { ticketIngestJobSchema, type TicketIngestJob } from '@aqar/contracts';
import { ticketsTools } from '@aqar/tools';
import type { ToolContext } from '../context.js';
import { canWrite } from '../env.js';
import { ToolError } from '../errors.js';
import { gate } from '../gate.js';
import { recordAudit } from '../audit.js';
import { deterministicId } from '../ids.js';
import { createProposal } from '../proposals.js';
import { enqueueTriage, type EnqueueOutcome } from '../queue.js';
import { ok } from '../result.js';
import { registerReadTools } from './core.js';

const localeSchema = z.enum(['ar', 'en']);

export function registerTicketTools(server: McpServer, ctx: ToolContext): void {
  registerReadTools(server, ctx, ticketsTools);

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
