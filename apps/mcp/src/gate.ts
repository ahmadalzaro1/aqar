/**
 * The policy gate. Every mutating tool asks this before it touches a row.
 *
 * `evaluatePolicy` lives in @aqar/core (pure, deterministic, no I/O); this file
 * only *supplies* its inputs from real database state. That split matters: the
 * rule engine cannot be bent by a creative row of data, and the data fetch cannot
 * invent a verdict.
 *
 * Two properties worth stating out loud:
 *
 *  - `humanApprovalTokenPresent` is hard-coded false. An MCP caller has no
 *    channel to present one, so money and vendor-commit actions are denied by
 *    construction — no prompt can talk its way past it.
 *  - In `propose` mode the policy runs with `mode: 'dry_run'`, which denies
 *    execution while still telling the caller *why*. Proposals themselves are
 *    `draft_only`, which the engine always allows.
 */
import { evaluatePolicy } from '@aqar/core';
import type { PolicyAction, PolicyDecision } from '@aqar/contracts';
import type { TransactionSql } from 'postgres';
import type { ToolContext } from './context.js';

/** Local hour 0..23 in the property's timezone; quiet hours are local, not UTC. */
export function localHourIn(timeZone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const hour = formatter.formatToParts(at).find((part) => part.type === 'hour');
  const parsed = Number.parseInt(hour?.value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface GateRequest {
  readonly action: PolicyAction;
  readonly propertyId: string;
  readonly amountFils?: number;
  readonly vendorId?: string;
  readonly vendorOnAllowList?: boolean;
}

export async function gate(
  tx: TransactionSql,
  ctx: ToolContext,
  request: GateRequest,
): Promise<PolicyDecision> {
  const at = ctx.now();

  const spendRows = await tx<{ total: string | null }[]>`
    select coalesce(sum((args->>'amountFils')::bigint), 0)::text as total
      from action_proposals
     where organization_id = ${ctx.org.id}
       and status = 'executed'
       and executed_at >= date_trunc('day', now())
  `;
  const spendTodayFils = Number.parseInt(spendRows[0]?.total ?? '0', 10);

  const messageRows = await tx<{ count: string }[]>`
    select count(*)::text as count
      from ticket_messages
     where organization_id = ${ctx.org.id}
       and direction = 'outbound'
       and sent_at >= date_trunc('day', now())
  `;
  const tenantMessagesToday = Number.parseInt(messageRows[0]?.count ?? '0', 10);

  return evaluatePolicy({
    action: request.action,
    orgId: ctx.org.id,
    propertyId: request.propertyId,
    actor: ctx.cfg.actorName,
    mode: ctx.cfg.mode === 'live' ? 'live' : 'dry_run',
    amountFils: request.amountFils ?? null,
    vendorId: request.vendorId ?? null,
    vendorOnAllowList: request.vendorOnAllowList ?? false,
    nteLimitFils: null,
    approvalRequiredN: 0,
    approvalRequiredM: 0,
    approvalVotesYes: 0,
    localHour: localHourIn(ctx.org.timezone, at),
    quietHoursStart: ctx.cfg.quietHoursStart,
    quietHoursEnd: ctx.cfg.quietHoursEnd,
    tenantMessagesToday,
    tenantMessageDailyCap: ctx.cfg.tenantMessageDailyCap,
    orgSpendTodayFils: spendTodayFils,
    orgDailySpendCapFils: ctx.cfg.orgDailySpendCapFils,
    // Structural, not configurable: an MCP client cannot present an approval token.
    humanApprovalTokenPresent: false,
  });
}
