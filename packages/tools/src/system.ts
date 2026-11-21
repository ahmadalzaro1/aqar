/**
 * Orientation tool. Deliberately the cheapest thing to call: an agent that has
 * just connected learns which organization, which currency, which mode, and —
 * critically — what it is NOT allowed to do, before it tries anything.
 *
 * The policy limits come from `ToolContext.policy`, the snapshot the adapter
 * resolved at boot; the core never reads the environment itself.
 */
import { z } from 'zod';
import type { ToolContext } from './context.js';
import type { ToolDef } from './registry.js';

const emptyArgs = z.object({});

export const aqarContext: ToolDef = {
  name: 'aqar_context',
  kind: 'read',
  title: 'Aqar context',
  description:
    'Who am I acting as: organization, timezone, currency, agent mode, the policy limits in force, and live row counts. Call this first in a session.',
  schema: emptyArgs,
  async run(ctx: ToolContext, raw: unknown) {
    emptyArgs.parse(raw);
    const policy = ctx.policy;
    if (policy === undefined) {
      throw new Error('aqar_context needs a policy snapshot: the adapter must set ToolContext.policy');
    }

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

    return {
      organization: {
        id: ctx.org.id,
        slug: ctx.org.slug,
        name: ctx.org.name,
        timezone: ctx.org.timezone,
        currency: ctx.org.currency,
      },
      actor: policy.actor,
      mode: policy.mode,
      moneyRule: 'Amounts are integer fils. 1 JOD = 1000 fils. Never compute money yourself; report amountFils and amountJod as given.',
      mayWrite: policy.mode !== 'read_only',
      mayMoveMoney: false,
      moneyRuleDetail:
        'You cannot post payments, create charges, or dispatch vendors. Those tools only file a proposal; a human approves it in the console and a server job executes it. This is structural, not a preference.',
      policyLimits: {
        quietHours: `${String(policy.quietHoursStart)}:00–${String(policy.quietHoursEnd)}:00 local`,
        tenantMessagesPerDay: policy.tenantMessageDailyCap,
        organizationSpendPerDayFils: policy.orgDailySpendCapFils,
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
    };
  },
};

export const systemTools = [aqarContext] as const;
