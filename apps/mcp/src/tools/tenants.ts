/**
 * MCP adapter for the tenant tools.
 *
 * Reads (search_tenants, list_arrears, tenant_statement) are registered straight
 * from `@aqar/tools`, where their SQL lives. Writing a payment promise stays here
 * because it needs the policy gate, the audit trail and an idempotency key —
 * transport concerns the tool core must not carry.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { formatFils } from '@aqar/core';
import { tenantsTools } from '@aqar/tools';
import type { ToolContext } from '../context.js';
import { canWrite } from '../env.js';
import { ToolError } from '../errors.js';
import { gate } from '../gate.js';
import { recordAudit } from '../audit.js';
import { deterministicId } from '../ids.js';
import { ok } from '../result.js';
import { registerReadTools } from './core.js';

export function registerTenantTools(server: McpServer, ctx: ToolContext): void {
  registerReadTools(server, ctx, tenantsTools);

  server.registerTool(
    'log_payment_promise',
    {
      title: 'Log a payment promise',
      description:
        'Record that a tenant promised to pay an amount by a date (e.g. from a WhatsApp message). Creates a record for the collections workflow; it does not post a payment.',
      inputSchema: {
        tenantId: z.string().uuid(),
        amountFils: z.number().int().positive().describe('Promised amount in fils (1 JOD = 1000 fils)'),
        promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('ISO date YYYY-MM-DD'),
        note: z.string().max(500).optional(),
        sourceChannel: z.enum(['whatsapp', 'telegram', 'sms', 'email', 'in_app']).default('in_app'),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ tenantId, amountFils, promisedDate, note, sourceChannel, idempotencyKey }) => {
      if (!canWrite(ctx.cfg.mode)) {
        throw new ToolError('read_only_mode', 'This server is in read_only mode', 'Set AQAR_MCP_MODE=propose to record data.');
      }

      return ctx.sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${ctx.org.id}, true)`;

        const tenantRows = await tx<{ id: string; propertyId: string | null }[]>`
          select t.id, l.property_id as "propertyId"
            from tenants t
            left join lease_tenants lt on lt.tenant_id = t.id
            left join leases l on l.id = lt.lease_id and l.status = 'active'
           where t.organization_id = ${ctx.org.id} and t.id = ${tenantId}
           limit 1
        `;
        const tenant = tenantRows[0];
        if (tenant === undefined) {
          throw new ToolError('tenant_not_found', `No tenant ${tenantId} in this organization`);
        }

        const decision = await gate(tx, ctx, {
          action: 'draft_only',
          propertyId: tenant.propertyId ?? '00000000-0000-0000-0000-000000000000',
        });
        if (!decision.allowed) {
          throw new ToolError('policy_denied', `Policy denied logging the promise: ${decision.reasons.join(', ')}`);
        }

        // Deterministic when the caller supplies a key, random otherwise; either
        // way the id is explicit, so the insert has one fixed shape.
        const promiseId = idempotencyKey === undefined
          ? randomUUID()
          : deterministicId('aqar.promise', idempotencyKey);

        const inserted = await tx<{ id: string }[]>`
          insert into payment_promises (
            id, organization_id, tenant_id, amount_fils, promised_date,
            source_channel, note, created_by
          ) values (
            ${promiseId}, ${ctx.org.id}, ${tenantId}, ${amountFils}, ${promisedDate},
            ${sourceChannel}, ${note ?? null},
            ${tx.json({ kind: 'agent', name: ctx.cfg.actorName, model: ctx.cfg.modelId })}
          )
          on conflict (id) do nothing
          returning id
        `;

        const row = inserted[0];
        if (row === undefined) {
          const existing = await tx<{ id: string }[]>`
            select id from payment_promises
             where organization_id = ${ctx.org.id} and id = ${promiseId}
             limit 1
          `;
          const existingId = existing[0]?.id;
          if (existingId !== undefined) {
            return ok({ ok: true, duplicate: true, promiseId: existingId });
          }
          throw new ToolError('promise_insert_failed', 'The promise was not stored');
        }

        const auditId = await recordAudit(tx, {
          organizationId: ctx.org.id,
          action: 'payment_promise.logged',
          entityType: 'payment_promise',
          entityId: row.id,
          actor: { kind: 'agent', name: ctx.cfg.actorName, model: ctx.cfg.modelId },
          toolName: 'log_payment_promise',
          after: { tenantId, amountFils, promisedDate, sourceChannel, note: note ?? null },
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          occurredAt: ctx.now(),
        });

        return ok({
          ok: true,
          duplicate: false,
          promiseId: row.id,
          auditId,
          amountJod: formatFils(amountFils),
          promisedDate,
        });
      });
    },
  );
}
