import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { ok } from '../result.js';

/**
 * Orientation tool. Deliberately the cheapest thing to call: an agent that has
 * just connected learns which organization, which currency, which mode, and —
 * critically — what it is NOT allowed to do, before it tries anything.
 */
export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'aqar_context',
    {
      title: 'Aqar context',
      description:
        'Who am I acting as: organization, timezone, currency, agent mode, the policy limits in force, and live row counts. Call this first in a session.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const at = ctx.now();
      const counts = await ctx.sql<{
        properties: string;
        units: string;
        occupied: string;
        tenants: string;
        open_tickets: string;
        emergency_tickets: string;
        pending_proposals: string;
      }[]>`
        select
          (select count(*)::text from properties    where organization_id = ${ctx.org.id}) as properties,
          (select count(*)::text from units         where organization_id = ${ctx.org.id}) as units,
          (select count(*)::text from units         where organization_id = ${ctx.org.id} and status = 'occupied') as occupied,
          (select count(*)::text from tenants       where organization_id = ${ctx.org.id}) as tenants,
          (select count(*)::text from tickets       where organization_id = ${ctx.org.id} and status not in ('closed','cancelled')) as open_tickets,
          (select count(*)::text from tickets       where organization_id = ${ctx.org.id} and emergency_flag and status not in ('closed','cancelled')) as emergency_tickets,
          (select count(*)::text from action_proposals where organization_id = ${ctx.org.id} and status = 'pending') as pending_proposals
      `;
      const row = counts[0];

      return ok({
        organization: {
          id: ctx.org.id,
          slug: ctx.org.slug,
          name: ctx.org.name,
          timezone: ctx.org.timezone,
          currency: ctx.org.currency,
        },
        actor: ctx.cfg.actorName,
        mode: ctx.cfg.mode,
        moneyRule: 'Amounts are integer fils. 1 JOD = 1000 fils. Never compute money yourself; report amountFils and amountJod as given.',
        mayWrite: ctx.cfg.mode !== 'read_only',
        mayMoveMoney: false,
        moneyRuleDetail:
          'You cannot post payments, create charges, or dispatch vendors. Those tools only file a proposal; a human approves it in the console and a server job executes it. This is structural, not a preference.',
        policyLimits: {
          quietHours: `${String(ctx.cfg.quietHoursStart)}:00–${String(ctx.cfg.quietHoursEnd)}:00 local`,
          tenantMessagesPerDay: ctx.cfg.tenantMessageDailyCap,
          organizationSpendPerDayFils: ctx.cfg.orgDailySpendCapFils,
        },
        today: at.toISOString().slice(0, 10),
        counts: row === undefined ? {} : {
          properties: Number(row.properties),
          units: Number(row.units),
          occupiedUnits: Number(row.occupied),
          tenants: Number(row.tenants),
          openTickets: Number(row.open_tickets),
          emergencyTickets: Number(row.emergency_tickets),
          pendingProposals: Number(row.pending_proposals),
        },
        sourceTables:
          'properties, units, tenants, leases, charges, payments, payment_allocations, tickets, ticket_messages, action_proposals, payment_promises',
      });
    },
  );
}
