import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { formatFils } from '@aqar/core';
import type { ToolContext } from '../context.js';
import { canWrite } from '../env.js';
import { ToolError } from '../errors.js';
import { gate } from '../gate.js';
import { recordAudit } from '../audit.js';
import { deterministicId } from '../ids.js';
import { ok } from '../result.js';

/** Phone numbers are personal data: the agent sees the last four digits only. */
function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\s+/g, '');
  return digits.length <= 4 ? digits : `••••${digits.slice(-4)}`;
}

export function registerTenantTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_tenants',
    {
      title: 'Search tenants',
      description:
        'Find tenants by name (English or Arabic) or phone fragment. Returns masked phone numbers; use the tenantId for follow-up tools.',
      inputSchema: {
        query: z.string().min(2).max(80).describe('Name fragment or last digits of the phone'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, limit }) => {
      const like = `%${query}%`;
      const rows = await ctx.sql<{
        id: string; nameEn: string | null; nameAr: string | null; phone: string | null;
        email: string | null; unitNumber: string | null; property: string | null;
        leaseStatus: string | null; endDate: string | null;
      }[]>`
        select t.id,
               t.full_name_en as "nameEn",
               t.full_name_ar as "nameAr",
               t.phone,
               t.email,
               u.unit_number as "unitNumber",
               p.name as property,
               l.status::text as "leaseStatus",
               to_char(l.end_date, 'YYYY-MM-DD') as "endDate"
          from tenants t
          left join lease_tenants lt on lt.tenant_id = t.id
          left join leases l on l.id = lt.lease_id and l.status in ('active', 'upcoming')
          left join units u on u.id = l.unit_id
          left join properties p on p.id = l.property_id
         where t.organization_id = ${ctx.org.id}
           and (
             t.full_name_en ilike ${like}
             or t.full_name_ar ilike ${like}
             or coalesce(t.phone, '') like ${like}
           )
         order by t.full_name_en nulls last
         limit ${limit}
      `;

      return ok({
        count: rows.length,
        tenants: rows.map((row) => ({
          tenantId: row.id,
          nameEn: row.nameEn,
          nameAr: row.nameAr,
          phoneMasked: maskPhone(row.phone),
          email: row.email,
          unitNumber: row.unitNumber,
          property: row.property,
          leaseStatus: row.leaseStatus,
          leaseEnds: row.endDate,
        })),
      });
    },
  );

  server.registerTool(
    'list_arrears',
    {
      title: 'Tenants in arrears',
      description:
        'Every tenant whose allocated payments do not cover their charges, largest debt first, with the oldest unpaid due date. Amounts are integer fils.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => {
      const rows = await ctx.sql<{
        tenantId: string; nameEn: string | null; nameAr: string | null;
        unitNumber: string | null; property: string | null;
        chargedFils: string; allocatedFils: string; outstandingFils: string;
        oldestDue: string | null; daysLate: number | null; phone: string | null;
      }[]>`
        with charged as (
          select c.lease_id,
                 sum(c.amount_fils)::bigint as amount,
                 min(c.due_date) filter (where c.due_date <= current_date) as oldest_due
            from charges c
           where c.organization_id = ${ctx.org.id}
           group by c.lease_id
        ),
        allocated as (
          select c.lease_id, sum(pa.amount_fils)::bigint as amount
            from payment_allocations pa
            join charges c on c.id = pa.charge_id
           where pa.organization_id = ${ctx.org.id}
           group by c.lease_id
        )
        select t.id as "tenantId",
               t.full_name_en as "nameEn",
               t.full_name_ar as "nameAr",
               t.phone,
               u.unit_number as "unitNumber",
               p.name as property,
               coalesce(ch.amount, 0)::text as "chargedFils",
               coalesce(al.amount, 0)::text as "allocatedFils",
               (coalesce(ch.amount, 0) - coalesce(al.amount, 0))::text as "outstandingFils",
               to_char(ch.oldest_due, 'YYYY-MM-DD') as "oldestDue",
               case when ch.oldest_due is null then null else (current_date - ch.oldest_due) end as "daysLate"
          from tenants t
          join lease_tenants lt on lt.tenant_id = t.id
          join leases l on l.id = lt.lease_id and l.status = 'active'
          left join units u on u.id = l.unit_id
          left join properties p on p.id = l.property_id
          left join charged ch on ch.lease_id = l.id
          left join allocated al on al.lease_id = l.id
         where t.organization_id = ${ctx.org.id}
           and coalesce(ch.amount, 0) - coalesce(al.amount, 0) > 0
         order by (coalesce(ch.amount, 0) - coalesce(al.amount, 0)) desc
         limit ${limit}
      `;

      const tenants = rows.map((row) => {
        const outstanding = Number(row.outstandingFils);
        return {
          tenantId: row.tenantId,
          nameEn: row.nameEn,
          nameAr: row.nameAr,
          phoneMasked: maskPhone(row.phone),
          unitNumber: row.unitNumber,
          property: row.property,
          chargedFils: Number(row.chargedFils),
          allocatedFils: Number(row.allocatedFils),
          outstandingFils: outstanding,
          outstandingJod: formatFils(outstanding),
          oldestUnpaidDue: row.oldestDue,
          daysLate: row.daysLate,
        };
      });

      const totalOutstanding = tenants.reduce((sum, tenant) => sum + tenant.outstandingFils, 0);
      return ok({
        count: tenants.length,
        totalOutstandingFils: totalOutstanding,
        totalOutstandingJod: formatFils(totalOutstanding),
        tenants,
      });
    },
  );

  server.registerTool(
    'tenant_statement',
    {
      title: 'Tenant statement',
      description:
        'One tenant: charges with what is still unpaid on each, payments received, and any payment promises. Use for "why is my balance like this" questions.',
      inputSchema: {
        tenantId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ tenantId, limit }) => {
      const tenantRows = await ctx.sql<{ id: string; nameEn: string | null; nameAr: string | null; phone: string | null }[]>`
        select id, full_name_en as "nameEn", full_name_ar as "nameAr", phone
          from tenants
         where organization_id = ${ctx.org.id} and id = ${tenantId}
         limit 1
      `;
      const tenant = tenantRows[0];
      if (tenant === undefined) {
        throw new ToolError('tenant_not_found', `No tenant ${tenantId} in this organization`);
      }

      const charges = await ctx.sql<{
        id: string; period: string; kind: string; amountFils: number;
        dueDate: string; allocatedFils: string; outstandingFils: string; unitNumber: string | null;
      }[]>`
        select c.id,
               c.period,
               c.kind::text as kind,
               c.amount_fils as "amountFils",
               to_char(c.due_date, 'YYYY-MM-DD') as "dueDate",
               coalesce(sum(pa.amount_fils), 0)::text as "allocatedFils",
               (c.amount_fils - coalesce(sum(pa.amount_fils), 0))::text as "outstandingFils",
               u.unit_number as "unitNumber"
          from charges c
          join leases l on l.id = c.lease_id
          join lease_tenants lt on lt.lease_id = l.id
          left join units u on u.id = l.unit_id
          left join payment_allocations pa on pa.charge_id = c.id
         where c.organization_id = ${ctx.org.id}
           and lt.tenant_id = ${tenantId}
         group by c.id, u.unit_number
         order by c.due_date desc
         limit ${limit}
      `;

      const payments = await ctx.sql<{ id: string; amountFils: number; receivedDate: string; method: string; reference: string | null }[]>`
        select id,
               amount_fils as "amountFils",
               to_char(received_date, 'YYYY-MM-DD') as "receivedDate",
               method::text as method,
               reference_text as reference
          from payments
         where organization_id = ${ctx.org.id} and payer_id = ${tenantId}
         order by received_date desc
         limit ${limit}
      `;

      const promises = await ctx.sql<{ amountFils: number; promisedDate: string; status: string; note: string | null }[]>`
        select amount_fils as "amountFils",
               to_char(promised_date, 'YYYY-MM-DD') as "promisedDate",
               status,
               note
          from payment_promises
         where organization_id = ${ctx.org.id} and tenant_id = ${tenantId}
         order by promised_date desc
         limit 10
      `;

      const totalOutstanding = charges.reduce((sum, charge) => sum + Number(charge.outstandingFils), 0);

      return ok({
        tenant: {
          tenantId: tenant.id,
          nameEn: tenant.nameEn,
          nameAr: tenant.nameAr,
          phoneMasked: maskPhone(tenant.phone),
        },
        totalOutstandingFils: totalOutstanding,
        totalOutstandingJod: formatFils(totalOutstanding),
        charges: charges.map((charge) => ({
          chargeId: charge.id,
          period: charge.period,
          kind: charge.kind,
          unitNumber: charge.unitNumber,
          dueDate: charge.dueDate,
          amountFils: charge.amountFils,
          amountJod: formatFils(charge.amountFils),
          allocatedFils: Number(charge.allocatedFils),
          outstandingFils: Number(charge.outstandingFils),
          outstandingJod: formatFils(Math.max(0, Number(charge.outstandingFils))),
        })),
        payments: payments.map((payment) => ({
          paymentId: payment.id,
          receivedDate: payment.receivedDate,
          method: payment.method,
          reference: payment.reference,
          amountFils: payment.amountFils,
          amountJod: formatFils(payment.amountFils),
        })),
        promises: promises.map((promise) => ({
          amountFils: promise.amountFils,
          amountJod: formatFils(promise.amountFils),
          promisedDate: promise.promisedDate,
          status: promise.status,
          note: promise.note,
        })),
      });
    },
  );

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
