import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canonicalTrade, formatFils } from '@aqar/core';
import type { ToolContext } from '../context.js';
import { canWrite } from '../env.js';
import { ToolError } from '../errors.js';
import { createProposal } from '../proposals.js';
import { ok } from '../result.js';

/**
 * Money and vendor tools. Every one of them files a proposal — none of them
 * moves money, posts a charge, or dispatches anybody. That is not a limitation
 * to be worked around: an MCP caller cannot present a human approval token, so
 * the policy engine denies execution by construction.
 */
export function registerActionTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'propose_payment',
    {
      title: 'Propose posting a payment',
      description:
        'File a proposal to record a payment received (cash, CliQ, transfer, cheque) against a lease. A human must approve it before it enters the ledger. Use this instead of claiming a payment was recorded.',
      inputSchema: {
        leaseId: z.string().uuid(),
        amountFils: z.number().int().positive(),
        receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        method: z.enum(['cash', 'cliq', 'bank_transfer', 'cheque']).default('cash'),
        reference: z.string().max(120).optional(),
        note: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ leaseId, amountFils, receivedDate, method, reference, note }) => {
      if (!canWrite(ctx.cfg.mode)) {
        throw new ToolError('read_only_mode', 'This server is in read_only mode');
      }

      return ctx.sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${ctx.org.id}, true)`;

        const leaseRows = await tx<{ id: string; propertyId: string; tenant: string | null }[]>`
          select l.id, l.property_id as "propertyId",
                 coalesce(t.full_name_en, t.full_name_ar) as tenant
            from leases l
            left join lease_tenants lt on lt.lease_id = l.id and lt.is_primary
            left join tenants t on t.id = lt.tenant_id
           where l.organization_id = ${ctx.org.id} and l.id = ${leaseId}
           limit 1
        `;
        const lease = leaseRows[0];
        if (lease === undefined) {
          throw new ToolError('lease_not_found', `No lease ${leaseId} in this organization`);
        }

        const proposal = await createProposal(tx, ctx, {
          toolName: 'propose_payment',
          action: 'post_payment',
          propertyId: lease.propertyId,
          amountFils,
          args: {
            leaseId,
            amountFils,
            receivedDate,
            method,
            reference: reference ?? null,
            note: note ?? null,
          },
          summary: `Post payment ${formatFils(amountFils)} JOD from ${lease.tenant ?? 'tenant'} (${method}, ${receivedDate})`,
        });

        return ok({
          ok: true,
          proposalId: proposal.proposalId,
          duplicate: proposal.duplicate,
          expiresAt: proposal.expiresAt,
          posted: false,
          amountJod: formatFils(amountFils),
          policy: {
            allowedNow: proposal.policy.allowed,
            requiresHumanApproval: proposal.policy.requiresHumanApproval,
            reasons: proposal.policy.reasons,
          },
          note: 'Filed for approval. The ledger has NOT changed. Do not tell the user the payment is recorded.',
        });
      });
    },
  );

  server.registerTool(
    'propose_charge',
    {
      title: 'Propose creating a charge',
      description:
        'File a proposal to add a charge (rent, late fee, service, deposit, other) to a lease. A human must approve it before it is billed.',
      inputSchema: {
        leaseId: z.string().uuid(),
        kind: z.enum(['rent', 'late_fee', 'service', 'deposit', 'other']),
        amountFils: z.number().int().positive(),
        period: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .describe('Billing period YYYY-MM'),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ leaseId, kind, amountFils, period, dueDate, note }) => {
      if (!canWrite(ctx.cfg.mode)) {
        throw new ToolError('read_only_mode', 'This server is in read_only mode');
      }

      return ctx.sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${ctx.org.id}, true)`;

        const leaseRows = await tx<{ propertyId: string; tenant: string | null }[]>`
          select l.property_id as "propertyId", coalesce(t.full_name_en, t.full_name_ar) as tenant
            from leases l
            left join lease_tenants lt on lt.lease_id = l.id and lt.is_primary
            left join tenants t on t.id = lt.tenant_id
           where l.organization_id = ${ctx.org.id} and l.id = ${leaseId}
           limit 1
        `;
        const lease = leaseRows[0];
        if (lease === undefined) {
          throw new ToolError('lease_not_found', `No lease ${leaseId} in this organization`);
        }

        const proposal = await createProposal(tx, ctx, {
          toolName: 'propose_charge',
          action: 'create_charge',
          propertyId: lease.propertyId,
          amountFils,
          args: { leaseId, kind, amountFils, period, dueDate, note: note ?? null },
          summary: `Charge ${formatFils(amountFils)} JOD (${kind}) to ${lease.tenant ?? 'lease'} for ${period}, due ${dueDate}`,
        });

        return ok({
          ok: true,
          proposalId: proposal.proposalId,
          duplicate: proposal.duplicate,
          expiresAt: proposal.expiresAt,
          billed: false,
          amountJod: formatFils(amountFils),
          policy: {
            allowedNow: proposal.policy.allowed,
            requiresHumanApproval: proposal.policy.requiresHumanApproval,
            reasons: proposal.policy.reasons,
          },
          note: 'Filed for approval. Nothing has been billed.',
        });
      });
    },
  );

  server.registerTool(
    'propose_vendor_dispatch',
    {
      title: 'Propose dispatching a vendor',
      description:
        'File a proposal to send a vendor to a ticket. Above the not-to-exceed limit or off the allow-list, the policy engine will require human approval — which is the normal outcome, not an error.',
      inputSchema: {
        ticketId: z.string().uuid(),
        vendorId: z.string().uuid(),
        amountFils: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Quoted cost in fils, if known'),
        note: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ ticketId, vendorId, amountFils, note }) => {
      if (!canWrite(ctx.cfg.mode)) {
        throw new ToolError('read_only_mode', 'This server is in read_only mode');
      }

      return ctx.sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${ctx.org.id}, true)`;

        const ticketRows = await tx<
          { propertyId: string | null; subject: string; emergency: boolean }[]
        >`
          select property_id as "propertyId", subject, emergency_flag as emergency
            from tickets
           where organization_id = ${ctx.org.id} and id = ${ticketId}
           limit 1
        `;
        const ticket = ticketRows[0];
        if (ticket === undefined) {
          throw new ToolError('ticket_not_found', `No ticket ${ticketId} in this organization`);
        }
        if (ticket.propertyId === null) {
          throw new ToolError(
            'property_required',
            'The ticket has no property, so policy cannot be evaluated',
          );
        }

        const vendorRows = await tx<{ id: string; name: string; allowListed: boolean }[]>`
          select id, coalesce(name_en, name_ar) as name, allow_listed as "allowListed"
            from vendors
           where organization_id = ${ctx.org.id} and id = ${vendorId}
           limit 1
        `;
        const vendor = vendorRows[0];
        if (vendor === undefined) {
          throw new ToolError('vendor_not_found', `No vendor ${vendorId} in this organization`);
        }

        const proposal = await createProposal(tx, ctx, {
          toolName: 'propose_vendor_dispatch',
          action: 'dispatch_vendor',
          propertyId: ticket.propertyId,
          ...(amountFils === undefined ? {} : { amountFils }),
          vendorId,
          vendorOnAllowList: vendor.allowListed,
          args: { ticketId, vendorId, amountFils: amountFils ?? null, note: note ?? null },
          summary: `Dispatch ${vendor.name} to "${ticket.subject}"${amountFils === undefined ? '' : ` for ${formatFils(amountFils)} JOD`}${ticket.emergency ? ' (EMERGENCY)' : ''}`,
        });

        return ok({
          ok: true,
          proposalId: proposal.proposalId,
          duplicate: proposal.duplicate,
          expiresAt: proposal.expiresAt,
          dispatched: false,
          vendorAllowListed: vendor.allowListed,
          ticketIsEmergency: ticket.emergency,
          policy: {
            allowedNow: proposal.policy.allowed,
            requiresHumanApproval: proposal.policy.requiresHumanApproval,
            reasons: proposal.policy.reasons,
          },
          note: 'Filed for approval. Nobody has been dispatched.',
        });
      });
    },
  );

  server.registerTool(
    'list_proposals',
    {
      title: 'List action proposals',
      description:
        'Pending (and optionally settled) proposals waiting for a human decision, with what they would do and when they expire.',
      inputSchema: {
        status: z
          .enum(['pending', 'approved', 'rejected', 'executed', 'expired', 'failed', 'all'])
          .default('pending'),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ status, limit }) => {
      const rows = await ctx.sql<
        {
          id: string;
          toolName: string;
          action: string;
          summary: string;
          status: string;
          createdAt: Date;
          expiresAt: Date;
          decidedAt: Date | null;
          requester: unknown;
        }[]
      >`
        select id,
               tool_name as "toolName",
               action,
               summary,
               status,
               created_at as "createdAt",
               expires_at as "expiresAt",
               decided_at as "decidedAt",
               requested_by as requester
          from action_proposals
         where organization_id = ${ctx.org.id}
           and (${status} = 'all' or status = ${status})
         order by created_at desc
         limit ${limit}
      `;

      return ok({
        count: rows.length,
        proposals: rows.map((row) => ({
          proposalId: row.id,
          tool: row.toolName,
          action: row.action,
          summary: row.summary,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
          requestedBy: row.requester,
        })),
      });
    },
  );

  server.registerTool(
    'list_vendors',
    {
      title: 'List vendors',
      description:
        'Vendors with their trades, allow-list status, insurance expiry and rating. Use before proposing a dispatch.',
      inputSchema: {
        trade: z
          .string()
          .max(40)
          .optional()
          .describe(
            'Filter by trade. Everyday words resolve to the canonical token: plumbing and سباكة both mean plumber, electrical means electrician.',
          ),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ trade, limit }) => {
      // Matching is element-exact against the canonical token, not a substring
      // of the serialised array. Before this, `ilike '%plumbing%'` matched no
      // row at all once the roster stored `plumber`, and matched every vendor
      // whose array happened to contain the letters — the same question the
      // console answered differently, answered wrongly here.
      const token =
        trade === undefined ? null : (canonicalTrade(trade) ?? trade.trim().toLowerCase());
      const rows = await ctx.sql<
        {
          id: string;
          name: string;
          trades: unknown;
          allowListed: boolean;
          rating: string | null;
          insuranceExpiry: string | null;
        }[]
      >`
        select id,
               coalesce(name_en, name_ar) as name,
               trades,
               allow_listed as "allowListed",
               rating::text as rating,
               to_char(insurance_cert_expiry, 'YYYY-MM-DD') as "insuranceExpiry"
          from vendors
         where organization_id = ${ctx.org.id}
           and (${token}::text is null or trades ? ${token})
         order by allow_listed desc, rating desc nulls last
         limit ${limit}
      `;

      return ok({
        count: rows.length,
        vendors: rows.map((row) => ({
          vendorId: row.id,
          name: row.name,
          trades: row.trades,
          allowListed: row.allowListed,
          rating: row.rating === null ? null : Number(row.rating),
          insuranceExpiry: row.insuranceExpiry,
        })),
      });
    },
  );
}
