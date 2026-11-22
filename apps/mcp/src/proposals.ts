/**
 * Proposals: the only door through which an agent can ask for a consequential
 * action.
 *
 * A proposal is a database row, not a side effect. It commits nothing, contacts
 * nobody, and expires. A human approves it in the console; a separate server job
 * executes it with a real approval token. The model cannot call that job.
 *
 * `args_hash` plus the partial unique index means a retrying agent files one
 * pending proposal, not ten.
 */
import { describeArgProblems, validateActionArgs } from '@aqar/core';
import type { PolicyAction, PolicyDecision } from '@aqar/contracts';
import type { TransactionSql } from 'postgres';
import type { ToolContext } from './context.js';
import { argsHash } from './ids.js';
import { gate } from './gate.js';

export interface ProposalRequest {
  readonly toolName: string;
  /** PolicyAction vocabulary — the executor uses it to pick the right handler. */
  readonly action: PolicyAction;
  readonly propertyId: string;
  readonly args: Record<string, unknown>;
  /** One line rendered in the approval queue; says what changes and for whom. */
  readonly summary: string;
  readonly amountFils?: number;
  /** Vendor context: without these the policy preview would claim "not allow-listed". */
  readonly vendorId?: string;
  readonly vendorOnAllowList?: boolean;
  readonly idempotencyKey?: string;
  readonly expiresInHours?: number;
}

export interface ProposalResult {
  readonly proposalId: string;
  readonly duplicate: boolean;
  readonly expiresAt: string;
  readonly policy: PolicyDecision;
}

export async function createProposal(
  tx: TransactionSql,
  ctx: ToolContext,
  request: ProposalRequest,
): Promise<ProposalResult> {
  // Ask the real policy engine what *would* happen. The answer is returned to the
  // caller so the model can explain itself honestly ("this needs a human because
  // it is a dry-run / over the limit / quiet hours"), but it never gates the
  // proposal itself — filing a draft is always allowed.
  const policy = await gate(tx, ctx, {
    action: request.action,
    propertyId: request.propertyId,
    ...(request.amountFils === undefined ? {} : { amountFils: request.amountFils }),
    ...(request.vendorId === undefined ? {} : { vendorId: request.vendorId }),
    ...(request.vendorOnAllowList === undefined
      ? {}
      : { vendorOnAllowList: request.vendorOnAllowList }),
  });

  // Refuse to file a draft the executor could never run. The alternative is a
  // queue row that looks approvable and fails after a human has signed it.
  const problems = validateActionArgs(request.action, request.args);
  if (problems.length > 0) {
    throw new Error(`refusing to file ${request.action}: ${describeArgProblems(problems)}`);
  }

  const hash = argsHash({ action: request.action, ...request.args });
  const expiresAt = new Date(ctx.now().getTime() + (request.expiresInHours ?? 168) * 3_600_000);

  const rows = await tx<{ id: string; expires_at: Date }[]>`
    insert into action_proposals (
      organization_id, tool_name, action, args, args_hash, summary,
      requested_by, model_id, idempotency_key, expires_at
    ) values (
      ${ctx.org.id},
      ${request.toolName},
      ${request.action},
      ${tx.json(request.args)},
      ${hash},
      ${request.summary},
      ${tx.json({ kind: 'agent', name: ctx.cfg.actorName, model: ctx.cfg.modelId })},
      ${ctx.cfg.modelId},
      ${request.idempotencyKey ?? null},
      ${expiresAt}
    )
    on conflict (organization_id, args_hash) where status = 'pending' do nothing
    returning id, expires_at
  `;

  const created = rows[0];
  if (created !== undefined) {
    return {
      proposalId: created.id,
      duplicate: false,
      expiresAt: created.expires_at.toISOString(),
      policy,
    };
  }

  const existing = await tx<{ id: string; expires_at: Date }[]>`
    select id, expires_at
      from action_proposals
     where organization_id = ${ctx.org.id}
       and args_hash = ${hash}
       and status = 'pending'
     limit 1
  `;
  const found = existing[0];
  if (found === undefined) {
    throw new Error('proposal insert conflicted but no pending row was found');
  }
  return {
    proposalId: found.id,
    duplicate: true,
    expiresAt: found.expires_at.toISOString(),
    policy,
  };
}
