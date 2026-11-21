/**
 * The only code path that turns an approved proposal into an effect.
 *
 * A proposal is a row; approving it does three things in one transaction:
 *   1. re-reads the row `for update` and re-derives `args_hash` from the stored
 *      args, so a row edited after approval cannot be applied for other terms;
 *   2. mints an HMAC approval token for exactly those claims and verifies it
 *      against the row it just read — the signature is exercised, not decorative;
 *   3. spends the token exactly once — a `proposal_token_uses` row whose primary
 *      key is the proposal, so a second redemption conflicts at the database, not
 *      in a status check that anyone with write access could reset;
 *   4. runs the registered handler, records who decided and what happened, writes
 *      the audit event, and then — after the transaction commits — re-reads the
 *      row the handler wrote and records whether the effect is actually there.
 *
 * Step 4 is the honest part. A signature proves someone authorised these bytes;
 * it proves nothing about whether the write landed. `confirmed` in the result is
 * a fresh SELECT against the system of record, and it can be false.
 *
 * The model cannot reach this module: it lives in the console, it needs a session
 * user, and it needs the approval secret from the server environment.
 */
import { createHash } from 'node:crypto';
import { argsHash, mintApprovalToken, verifyApprovalToken } from '@aqar/approvals';
import {
  describeArgProblems,
  validateActionArgs,
  type PolicyRecord,
  type Requester,
} from '@aqar/core';
import type { TransactionSql } from 'postgres';
import { sql } from '@/lib/db';
import { loadPolicy } from './policy.js';

const TOKEN_TTL_MS = 5 * 60_000;

export type Decision = 'approve' | 'reject';

export type DecisionOutcome =
  | {
      /**
       * Dual control: this signature is recorded, the proposal is not executed,
       * and nothing has been spent. The row stays `pending` until enough distinct
       * approvers have signed.
       */
      readonly status: 'awaiting_approval';
      readonly proposalId: string;
      readonly signatures: number;
      readonly required: number;
      readonly reason: string;
      readonly policy: PolicyRecord;
    }
  | { readonly status: 'rejected'; readonly proposalId: string }
  | { readonly status: 'expired'; readonly proposalId: string }
  | {
      readonly status: 'executed';
      readonly proposalId: string;
      readonly result: Record<string, unknown>;
      /** True only when a post-commit SELECT found the row the handler wrote. */
      readonly confirmed: boolean;
    }
  | { readonly status: 'failed'; readonly proposalId: string; readonly reason: string };

export interface DecisionInput {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly decision: Decision;
}

/** What the handler claims it wrote, so the caller can go and look. */
interface VerifySpec {
  readonly table: 'payments' | 'work_orders';
  readonly id: string;
  readonly expect: Readonly<Record<string, unknown>>;
}

interface HandlerOutcome {
  readonly result: Record<string, unknown>;
  readonly verify: VerifySpec;
}

interface ProposalRow {
  readonly id: string;
  readonly organization_id: string;
  readonly tool_name: string;
  readonly action: string;
  readonly args: Record<string, unknown>;
  readonly args_hash: string;
  readonly summary: string;
  readonly status: string;
  readonly expires_at: Date;
  readonly model_id: string | null;
  /** `{kind:'agent',…}` or `{userId, via:'console'}` — who filed it, and how. */
  readonly requested_by: unknown;
}

/**
 * Read the filer out of `requested_by`. Two shapes exist in the table: the agent
 * tool writes `{kind:'agent', name, model}`, the console writes
 * `{userId, via:'console'}`. An unrecognised shape yields `undefined` rather
 * than a guess, and the separation-of-duties rule then simply does not fire —
 * the decision record shows that it was not applied.
 */
function requesterOf(raw: unknown): Requester | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj['kind'] === 'agent') return { kind: 'agent' };
  const userId = obj['userId'];
  if (typeof userId === 'string' && userId.length > 0) return { kind: 'human', userId };
  return undefined;
}

type Handler = (
  tx: TransactionSql,
  args: Record<string, unknown>,
  ctx: { organizationId: string; userId: string; now: Date },
) => Promise<HandlerOutcome>;

function need<T>(args: Record<string, unknown>, key: string, check: (v: unknown) => v is T, what: string): T {
  const value = args[key];
  if (value === undefined || value === null) throw new Error(`proposal args are missing "${key}" (${what})`);
  if (!check(value)) throw new Error(`proposal args "${key}" is not a valid ${what}`);
  return value;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isFils = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);


const handlers: Record<string, Handler> = {
  async post_payment(tx, args, ctx) {
    const leaseId = need(args, 'leaseId', isString, 'lease id');
    const amountFils = need(args, 'amountFils', isFils, 'positive integer fils');
    const receivedDate = need(args, 'receivedDate', isIsoDate, 'ISO date');
    const method = need(args, 'method', isString, 'payment method');
    // A cheque is a different obligation from cash, and the database says so:
    // `payments_cheque_status_ck` requires a status for a cheque and forbids one
    // for anything else. The proposer checks the same contract, but a legacy row
    // can still arrive here, so check again and name the field.
    const problems = validateActionArgs('post_payment', args);
    if (problems.length > 0) throw new Error(describeArgProblems(problems));
    const rawChequeStatus = args['chequeStatus'];
    const chequeStatus = typeof rawChequeStatus === 'string' ? rawChequeStatus : null;

    // The payer is the lease's primary tenant: tenants are never columns on
    // leases, a lease can have several, and only the primary one pays.
    const payers = await tx<{ tenant_id: string }[]>`
      select lt.tenant_id
        from lease_tenants lt
        join leases l on l.id = lt.lease_id and l.organization_id = lt.organization_id
       where lt.lease_id = ${leaseId} and lt.organization_id = ${ctx.organizationId}
       order by lt.is_primary desc, lt.signed_at asc nulls last
       limit 1
    `;
    const lease = payers[0];
    if (lease === undefined) throw new Error('the lease in this proposal no longer exists, or has no tenant');

    const reference = typeof args['reference'] === 'string' ? args['reference'] : null;
    const note = typeof args['note'] === 'string' ? args['note'] : null;

    const inserted = await tx<{ id: string }[]>`
      insert into payments (organization_id, payer_id, amount_fils, received_date, method, cheque_status, reference_text, notes)
      values (${ctx.organizationId}, ${lease.tenant_id}, ${amountFils}, ${receivedDate},
              ${method}::payment_method, ${chequeStatus}::cheque_status, ${reference}, ${note})
      returning id
    `;
    const paymentId = inserted[0]?.id;
    if (paymentId === undefined) throw new Error('payment insert returned no row');

    // Allocations are optional: money can arrive before it is applied to charges.
    const rawAllocations = args['allocations'];
    let allocated = 0;
    if (Array.isArray(rawAllocations)) {
      for (const entry of rawAllocations) {
        if (entry === null || typeof entry !== 'object') throw new Error('allocation entries must be objects');
        const { chargeId, amountFils: part } = entry as Record<string, unknown>;
        if (!isString(chargeId) || !isFils(part)) throw new Error('each allocation needs chargeId and positive amountFils');
        await tx`
          insert into payment_allocations (organization_id, payment_id, charge_id, amount_fils)
          values (${ctx.organizationId}, ${paymentId}, ${chargeId}, ${part})
        `;
        allocated += part;
      }
      if (allocated > amountFils) throw new Error('allocations exceed the payment amount');
    }

    return {
      result: { paymentId, amountFils, allocatedFils: allocated, method, receivedDate },
      verify: {
        table: 'payments',
        id: paymentId,
        expect: { amount_fils: amountFils, method, received_date: receivedDate, payer_id: lease.tenant_id },
      },
    };
  },

  async dispatch_vendor(tx, args, ctx) {
    const ticketId = need(args, 'ticketId', isString, 'ticket id');
    const vendorId = need(args, 'vendorId', isString, 'vendor id');
    const nteFils = isFils(args['amountFils']) ? args['amountFils'] : null;
    const note = typeof args['note'] === 'string' ? args['note'] : 'Dispatched from an approved proposal';

    const tickets = await tx<{ id: string }[]>`
      select id from tickets where id = ${ticketId} and organization_id = ${ctx.organizationId}
    `;
    if (tickets[0] === undefined) throw new Error('the ticket in this proposal no longer exists');
    const vendors = await tx<{ id: string }[]>`
      select id from vendors where id = ${vendorId} and organization_id = ${ctx.organizationId}
    `;
    if (vendors[0] === undefined) throw new Error('the vendor in this proposal no longer exists');

    const inserted = await tx<{ id: string }[]>`
      insert into work_orders (
        organization_id, ticket_id, vendor_id, status, scope_md, nte_fils, created_by_user_id, approved_at
      ) values (
        ${ctx.organizationId}, ${ticketId}, ${vendorId}, 'dispatched'::work_order_status, ${note},
        ${nteFils}, ${ctx.userId}, ${ctx.now}
      )
      returning id
    `;
    const workOrderId = inserted[0]?.id;
    if (workOrderId === undefined) throw new Error('work order insert returned no row');
    return {
      result: { workOrderId, ticketId, vendorId, nteFils, status: 'dispatched' },
      verify: { table: 'work_orders', id: workOrderId, expect: { ticket_id: ticketId, vendor_id: vendorId, status: 'dispatched' } },
    };
  },
};

export const registeredActions = Object.freeze(Object.keys(handlers));

/**
 * Compiled once, at module load. The limits are closed over, so no caller can
 * hand the executor a wider ceiling; the decision carries the policy version.
 */
// Loaded per organization, not per deployment: an org may override the limits in
// `policy_limits`, and the compiled version is stamped on the decision.

type TxOutcome =
  | {
      readonly kind: 'awaiting_approval';
      readonly proposalId: string;
      readonly signatures: number;
      readonly required: number;
      readonly reason: string;
      readonly policy: PolicyRecord;
    }
  | { readonly kind: 'rejected'; readonly proposalId: string }
  | { readonly kind: 'expired'; readonly proposalId: string }
  | { readonly kind: 'failed'; readonly proposalId: string; readonly reason: string }
  | {
      readonly kind: 'executed';
      readonly proposalId: string;
      readonly result: Record<string, unknown>;
      readonly verify: VerifySpec;
      readonly claims: unknown;
      readonly policyRules: number;
      readonly policy: PolicyRecord;
    };

export async function decideProposal(input: DecisionInput): Promise<DecisionOutcome> {
  const secret = process.env['AQAR_APPROVAL_SECRET'];
  if (secret === undefined || secret.length < 32) {
    throw new Error('AQAR_APPROVAL_SECRET is not set (min 32 chars) — refusing to approve anything unsigned');
  }

  const outcome = await sql.begin(async (tx): Promise<TxOutcome> => {
    const rows = await tx<ProposalRow[]>`
      select id, organization_id, tool_name, action, args, args_hash, summary, status, expires_at, model_id, requested_by
        from action_proposals
       where id = ${input.proposalId} and organization_id = ${input.organizationId}
       for update
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('proposal not found in this organization');
    if (row.status !== 'pending') throw new Error(`proposal is already ${row.status}`);

    const now = new Date();

    if (input.decision === 'reject') {
      await tx`
        update action_proposals
           set status = 'rejected', decided_by_user_id = ${input.userId}, decided_at = ${now}
         where id = ${row.id}
      `;
      await audit(tx, row, input, 'proposal.rejected', null);
      return { kind: 'rejected', proposalId: row.id } as TxOutcome;
    }

    if (row.expires_at.getTime() <= now.getTime()) {
      await tx`update action_proposals set status = 'expired' where id = ${row.id}`;
      await audit(tx, row, input, 'proposal.expired', null);
      return { kind: 'expired', proposalId: row.id } as TxOutcome;
    }

    // The stored hash is the thing the token signs. If the args were edited after
    // the agent filed the proposal, this is where it stops.
    const recomputed = argsHash({ action: row.action, ...row.args });
    if (recomputed !== row.args_hash) {
      throw new Error('proposal arguments do not match the hash that was filed — refusing to execute');
    }

    // Dual control: record this signature first, then let the policy judge the
    // signatures that now exist. The primary key is (proposal_id, approver_id),
    // so a retry or a double click cannot manufacture the second key — the
    // database refuses the duplicate, not this handler.
    await tx`
      insert into proposal_approvals (proposal_id, approver_id, role)
      values (${row.id}, ${input.userId}, ${input.role})
      on conflict (proposal_id, approver_id) do nothing
    `;
    const signatures = await tx<{ approver_id: string }[]>`
      select approver_id from proposal_approvals where proposal_id = ${row.id} order by approved_at
    `;

    // Policy is a predicate over the call's own fields, not a model's opinion and
    // not a role check bolted onto the route. A refusal here names its rules.
    const requester = requesterOf(row.requested_by);
    const policy = await loadPolicy(row.organization_id);

    const decision = policy.decide({
      kind: 'proposal',
      action: row.action,
      args: row.args,
      role: input.role,
      actorId: input.userId,
      approvals: signatures.map((s) => ({ userId: s.approver_id })),
      ...(requester === undefined ? {} : { requester }),
    });
    if (decision.verdict === 'deny') {
      const reasons = decision.decisive.map((r) => `${r.rule} (${r.detail})`).join('; ');
      throw new Error(`policy denied this proposal: ${reasons}`);
    }
    const policyRecord = policy.record(decision);

    // Below the threshold the concurrence rule reports `allow` and never appears
    // in `decisive`, so this cannot fire for an ordinary proposal.
    const shortOfSignatures = decision.decisive.find((r) => r.rule === 'concurrence.distinct_approvers');
    if (shortOfSignatures !== undefined) {
      return {
        kind: 'awaiting_approval',
        proposalId: row.id,
        signatures: signatures.length,
        required: policy.limits.requiredApprovers,
        reason: shortOfSignatures.detail,
        policy: policyRecord,
      } as TxOutcome;
    }

    const { token, claims } = mintApprovalToken(secret, {
      proposalId: row.id,
      toolName: row.tool_name,
      argsHash: row.args_hash,
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
      approvedByUserId: input.userId,
    });
    const verified = verifyApprovalToken({
      secret,
      token,
      now,
      expected: { proposalId: row.id, toolName: row.tool_name, argsHash: row.args_hash },
    });
    if (!verified.ok) throw new Error(`approval token failed verification: ${verified.reason}`);

    const handler = handlers[row.action];
    if (handler === undefined) {
      const reason = `no executor is registered for action "${row.action}"`;
      await tx`
        update action_proposals
           set status = 'failed', decided_by_user_id = ${input.userId}, decided_at = ${now},
               executed_at = ${now}, result = ${tx.json({ error: reason })}
         where id = ${row.id}
      `;
      await audit(tx, row, input, 'proposal.failed', { error: reason, claims });
      return { kind: 'failed', proposalId: row.id, reason } as TxOutcome;
    }

    // Spend the token. The primary key on proposal_id is the real single-use
    // guarantee: a second redemption cannot insert, so it cannot proceed, even if
    // the proposal row were reset to pending by hand.
    const redemptions = await tx<{ proposal_id: string }[]>`
      insert into proposal_token_uses (proposal_id, organization_id, token_hash, claims, consumed_at, consumed_by_user_id)
      values (
        ${row.id}, ${input.organizationId}, ${createHash('sha256').update(token).digest('hex')},
        ${tx.json(claims)}, ${now}, ${input.userId}
      )
      on conflict (proposal_id) do nothing
      returning proposal_id
    `;
    if (redemptions.length === 0) {
      throw new Error('this approval token has already been redeemed — refusing to execute again');
    }

    try {
      const outcome = await handler(tx, row.args, { organizationId: input.organizationId, userId: input.userId, now });
      await tx`
        update action_proposals
           set status = 'executed', decided_by_user_id = ${input.userId}, decided_at = ${now},
               executed_at = ${now}, result = ${tx.json({ ...outcome.result, confirmed: null })}
         where id = ${row.id}
      `;
      await audit(tx, row, input, 'proposal.executed', { ...outcome.result, claims, policy: policyRecord });
      return {
        kind: 'executed',
        proposalId: row.id,
        result: outcome.result,
        verify: outcome.verify,
        claims,
        policyRules: decision.rules.length,
        policy: policyRecord,
      } as TxOutcome;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await tx`
        update action_proposals
           set status = 'failed', decided_by_user_id = ${input.userId}, decided_at = ${now},
               executed_at = ${now}, result = ${tx.json({ error: reason })}
         where id = ${row.id}
      `;
      await audit(tx, row, input, 'proposal.failed', { error: reason, claims });
      return { kind: 'failed', proposalId: row.id, reason } as TxOutcome;
    }
  });

  if (outcome.kind === 'awaiting_approval') {
    return {
      status: 'awaiting_approval',
      proposalId: outcome.proposalId,
      signatures: outcome.signatures,
      required: outcome.required,
      reason: outcome.reason,
      policy: outcome.policy,
    };
  }
  if (outcome.kind === 'rejected') return { status: 'rejected', proposalId: outcome.proposalId };
  if (outcome.kind === 'expired') return { status: 'expired', proposalId: outcome.proposalId };
  if (outcome.kind === 'failed') return { status: 'failed', proposalId: outcome.proposalId, reason: outcome.reason };

  // The write is committed. Now go and look at it: a committed insert is not the
  // same claim as "the row is there, with the values we said" — a trigger, a
  // cascading delete or a wrong column would all pass the first test and fail this.
  const readBack = await confirmWrite(outcome.verify, input.organizationId);
  const result: Record<string, unknown> = {
    ...outcome.result,
    confirmed: readBack.confirmed,
    readBack: readBack.observed,
    // The decision that let this happen, with the policy that made it — so a
    // later edit to the limits cannot rewrite what this row means.
    policy: outcome.policy,
    ...(readBack.confirmed ? {} : { readBackMisses: readBack.misses }),
  };

  await sql`
    update action_proposals set result = ${sql.json(result)} where id = ${outcome.proposalId}
  `;
  await sql`
    insert into audit_events (
      organization_id, actor, action, entity_type, entity_id, before, after,
      occurred_at, model_id, tool_calls, idempotency_key
    ) values (
      ${input.organizationId},
      ${sql.json({ kind: 'human', userId: input.userId })},
      ${readBack.confirmed ? 'proposal.confirmed' : 'proposal.unconfirmed'},
      'action_proposal',
      ${outcome.proposalId},
      ${sql.json({ status: 'executed', claimed: outcome.result })},
      ${sql.json({ confirmed: readBack.confirmed, observed: readBack.observed, misses: readBack.misses, policy: outcome.policy })},
      ${new Date()},
      null,
      ${sql.json([{ tool: 'approval-readback', table: outcome.verify.table, rows: readBack.observed }])},
      ${`proposal:${outcome.proposalId}:confirm`}
    )
  `;

  return { status: 'executed', proposalId: outcome.proposalId, result, confirmed: readBack.confirmed };
}

interface ReadBackReport {
  readonly confirmed: boolean;
  readonly observed: Record<string, unknown>;
  readonly misses: readonly string[];
}

/**
 * Read the effect back out of the system of record. Deliberately not a dynamic
 * query: the table is a closed union and each branch is a literal, so nothing in
 * a proposal can decide what gets read.
 */
async function confirmWrite(spec: VerifySpec, organizationId: string): Promise<ReadBackReport> {
  const rows: Record<string, unknown>[] =
    spec.table === 'payments'
      ? await sql<Record<string, unknown>[]>`
          select id, organization_id, payer_id, amount_fils, received_date, method
            from payments where id = ${spec.id} and organization_id = ${organizationId}
        `
      : await sql<Record<string, unknown>[]>`
          select id, organization_id, ticket_id, vendor_id, status
            from work_orders where id = ${spec.id} and organization_id = ${organizationId}
        `;

  const row = rows[0];
  if (row === undefined) return { confirmed: false, observed: {}, misses: ['the row is not in the table after commit'] };

  const observed: Record<string, unknown> = {};
  const misses: string[] = [];
  for (const [key, expected] of Object.entries(spec.expect)) {
    const actual = row[key];
    observed[key] = actual instanceof Date ? actual.toISOString().slice(0, 10) : actual;
    if (!sameValue(expected, actual)) {
      misses.push(`${key}: expected ${String(expected)}, found ${String(actual)}`);
    }
  }
  return { confirmed: misses.length === 0, observed, misses };
}

/** Postgres hands back dates as Date and numerics as number or string; compare loosely but exactly. */
function sameValue(expected: unknown, actual: unknown): boolean {
  if (actual instanceof Date) return String(expected) === actual.toISOString().slice(0, 10);
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  return String(expected) === String(actual);
}

async function audit(
  tx: TransactionSql,
  row: ProposalRow,
  input: DecisionInput,
  action: string,
  after: Record<string, unknown> | null,
): Promise<void> {
  await tx`
    insert into audit_events (
      organization_id, actor, action, entity_type, entity_id, before, after,
      model_id, tool_calls, idempotency_key, occurred_at
    ) values (
      ${input.organizationId},
      ${tx.json({ kind: 'human', userId: input.userId })},
      ${action},
      'action_proposal',
      ${row.id},
      ${tx.json({ status: 'pending', summary: row.summary, args: row.args })},
      ${tx.json(after ?? { status: 'rejected' })},
      ${row.model_id},
      ${tx.json([{ tool: row.tool_name, action: row.action }])},
      ${`proposal:${row.id}:${action}`},
      ${new Date()}
    )
  `;
}
