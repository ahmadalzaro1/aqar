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
import { DEFAULT_POLICY_LIMITS, evaluateProposal } from '@aqar/core';
import type { TransactionSql } from 'postgres';
import { sql } from '@/lib/db';

const TOKEN_TTL_MS = 5 * 60_000;

export type Decision = 'approve' | 'reject';

export type DecisionOutcome =
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
  readonly tool_name: string;
  readonly action: string;
  readonly args: Record<string, unknown>;
  readonly args_hash: string;
  readonly summary: string;
  readonly status: string;
  readonly expires_at: Date;
  readonly model_id: string | null;
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

const PAYMENT_METHODS = new Set(['cash', 'cliq', 'bank_transfer', 'cheque']);

const handlers: Record<string, Handler> = {
  async post_payment(tx, args, ctx) {
    const leaseId = need(args, 'leaseId', isString, 'lease id');
    const amountFils = need(args, 'amountFils', isFils, 'positive integer fils');
    const receivedDate = need(args, 'receivedDate', isIsoDate, 'ISO date');
    const method = need(args, 'method', isString, 'payment method');
    if (!PAYMENT_METHODS.has(method)) throw new Error(`unknown payment method "${method}"`);

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
      insert into payments (organization_id, payer_id, amount_fils, received_date, method, reference_text, notes)
      values (${ctx.organizationId}, ${lease.tenant_id}, ${amountFils}, ${receivedDate},
              ${method}::payment_method, ${reference}, ${note})
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

type TxOutcome =
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
    };

export async function decideProposal(input: DecisionInput): Promise<DecisionOutcome> {
  const secret = process.env['AQAR_APPROVAL_SECRET'];
  if (secret === undefined || secret.length < 32) {
    throw new Error('AQAR_APPROVAL_SECRET is not set (min 32 chars) — refusing to approve anything unsigned');
  }

  const outcome = await sql.begin(async (tx): Promise<TxOutcome> => {
    const rows = await tx<ProposalRow[]>`
      select id, tool_name, action, args, args_hash, summary, status, expires_at, model_id
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

    // Policy is a predicate over the call's own fields, not a model's opinion and
    // not a role check bolted onto the route. A refusal here names its rules.
    const policy = evaluateProposal({ action: row.action, args: row.args, role: input.role, limits: DEFAULT_POLICY_LIMITS });
    if (policy.verdict === 'deny') {
      const reasons = policy.decisive.map((r) => `${r.rule} (${r.detail})`).join('; ');
      throw new Error(`policy denied this proposal: ${reasons}`);
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
      await audit(tx, row, input, 'proposal.executed', { ...outcome.result, claims, policy: policy.verdict });
      return {
        kind: 'executed',
        proposalId: row.id,
        result: outcome.result,
        verify: outcome.verify,
        claims,
        policyRules: policy.rules.length,
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
      ${sql.json({ confirmed: readBack.confirmed, observed: readBack.observed, misses: readBack.misses })},
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
