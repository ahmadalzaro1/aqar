/**
 * Reversal — the half of LAW 3 that was missing.
 *
 * "Every action is attributed and reversible" was true of the first clause only:
 * an executed proposal had an actor, a timestamp and a diff, and no way back. This
 * module closes it, with three rules that matter more than the code:
 *
 *   1. **Only a confirmed execution is reversible.** If the executor's read-back
 *      said the row was not there, there is nothing to reverse and reversing would
 *      manufacture an effect that never happened.
 *   2. **Nothing is hard-deleted.** A voided receipt keeps its row, its amount and
 *      its date; `voided_at` stops it counting. The ledger answers "what happened"
 *      forever and "what counts" right now.
 *   3. **Reversal is itself single-use.** `proposal_reversals` keys on the
 *      proposal, so the second attempt conflicts at the database.
 *
 * Console-only, like the executor: needs a session user and a server-side
 * connection. The model cannot reach it.
 */
import { compilePolicy, PolicyDeniedError, type PolicyRecord } from '@aqar/core';
import type { TransactionSql } from 'postgres';
import { sql } from '@/lib/db';

/**
 * Compiled once, at module load: the limits are closed over, so no caller can
 * pass a different ceiling and no route can re-implement the role check.
 */
const POLICY = compilePolicy();

export type ReversalOutcome =
  | { readonly status: 'reversed'; readonly proposalId: string; readonly effect: Record<string, unknown>; readonly confirmed: boolean; readonly policy: PolicyRecord }
  | { readonly status: 'refused'; readonly proposalId: string; readonly reason: string };

export interface ReversalInput {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly reason: string;
}

interface ProposalRow {
  readonly id: string;
  readonly action: string;
  readonly args: Record<string, unknown>;
  readonly status: string;
  readonly result: Record<string, unknown> | null;
  readonly executed_at: Date | null;
}

interface ReversalContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly reason: string;
  readonly now: Date;
}

interface ReversalEffect {
  readonly effect: Record<string, unknown>;
  /**
   * Re-reads the affected row after the transaction commits, so "reversed" is
   * never another assertion. Each reverser owns its own check: a table name
   * alone cannot answer "is it voided", and a switch on `effect.kind` silently
   * verifies the wrong table as soon as a third reverser is added.
   */
  readonly readback: () => Promise<boolean>;
}

type Reverser = (tx: TransactionSql, row: ProposalRow, ctx: ReversalContext) => Promise<ReversalEffect>;

function idFrom(row: ProposalRow, key: string): string {
  const value = row.result?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`the executed result has no ${key} — nothing to reverse`);
  }
  return value;
}

const reversers: Record<string, Reverser> = {
  async post_payment(tx, row, ctx) {
    const paymentId = idFrom(row, 'paymentId');
    const voided = await tx<{ id: string }[]>`
      update payments
         set voided_at = ${ctx.now}, void_reason = ${ctx.reason}, voided_by_user_id = ${ctx.userId}
       where id = ${paymentId} and organization_id = ${ctx.organizationId} and voided_at is null
       returning id
    `;
    if (voided.length === 0) throw new Error('that receipt is already voided, or it is not there any more');
    return {
      effect: { kind: 'payment_voided', paymentId, voidedAt: ctx.now.toISOString() },
      readback: async () => {
        const rows = await sql<{ n: number }[]>`
          select count(*)::int as n from payments
           where id = ${paymentId} and organization_id = ${ctx.organizationId} and voided_at is not null
        `;
        return rows[0]!.n === 1;
      },
    };
  },

  async dispatch_vendor(tx, row, ctx) {
    const workOrderId = idFrom(row, 'workOrderId');
    const cancelled = await tx<{ id: string }[]>`
      update work_orders
         set status = 'cancelled'
       where id = ${workOrderId} and organization_id = ${ctx.organizationId} and status <> 'cancelled'
       returning id
    `;
    if (cancelled.length === 0) throw new Error('that work order is already cancelled, or it is not there any more');
    return {
      effect: { kind: 'work_order_cancelled', workOrderId, reason: ctx.reason },
      readback: async () => {
        const rows = await sql<{ n: number }[]>`
          select count(*)::int as n from work_orders
           where id = ${workOrderId} and organization_id = ${ctx.organizationId} and status = 'cancelled'
        `;
        return rows[0]!.n === 1;
      },
    };
  },
};

export async function reverseProposal(input: ReversalInput): Promise<ReversalOutcome> {
  if (input.reason.trim().length < 10) {
    throw new Error('a reversal needs a reason of at least 10 characters — it becomes part of the audit trail');
  }
  // Set inside the transaction, called after it commits. A holder object rather
  // than a `let`: TypeScript narrows a `let` assigned only inside a closure to
  // `null` at the use site, and the check would silently pass.
  const pending: { readback: (() => Promise<boolean>) | null } = { readback: null };

  const outcome = await sql.begin(async (tx): Promise<ReversalOutcome> => {
    const rows = await tx<ProposalRow[]>`
      select id, action, args, status, result, executed_at
        from action_proposals
       where id = ${input.proposalId} and organization_id = ${input.organizationId}
       for update
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('proposal not found in this organization');
    if (row.status === 'reversed') throw new Error('this proposal has already been reversed');
    if (row.status !== 'executed') throw new Error(`only an executed proposal can be reversed; this one is ${row.status}`);

    if (row.executed_at === null) {
      return { status: 'refused', proposalId: row.id, reason: 'this proposal has no execution timestamp, so its reversal window cannot be judged' };
    }

    // The policy is compiled: the limits are closed over, so this gate cannot be
    // widened by a caller and there is no role list to re-implement in a route.
    // It runs after the state checks because "there is nothing to undo" is the
    // answer that stops an operator fastest, and before anything is written.
    const now = new Date();
    const decision = POLICY.decide({
      kind: 'reversal',
      action: row.action,
      role: input.role,
      actorId: input.userId,
      executedAt: row.executed_at.toISOString(),
      now: now.toISOString(),
    });
    if (decision.verdict === 'deny') throw new PolicyDeniedError('the reversal', decision, POLICY.version);
    const record = POLICY.record(decision);

    // Rule 1: a reversal of an unconfirmed write would be an invention.
    if (row.result?.['confirmed'] !== true) {
      return { status: 'refused', proposalId: row.id, reason: 'the execution was never confirmed by read-back, so there is no effect to reverse' };
    }

    const reverser = reversers[row.action];
    if (reverser === undefined) {
      return { status: 'refused', proposalId: row.id, reason: `no reversal exists for action "${row.action}"` };
    }

    const ctx: ReversalContext = {
      organizationId: input.organizationId,
      userId: input.userId,
      reason: input.reason.trim(),
      now,
    };

    const { effect, readback } = await reverser(tx, row, ctx);
    pending.readback = readback;

    const executedAudit = await tx<{ id: string }[]>`
      select id from audit_events
       where entity_type = 'action_proposal' and entity_id = ${row.id} and action = 'proposal.executed'
       order by occurred_at desc limit 1
    `;

    await tx`
      insert into proposal_reversals (proposal_id, organization_id, reversed_by_user_id, reason, reversed_at, effect, audit_event_id)
      values (${row.id}, ${input.organizationId}, ${input.userId}, ${ctx.reason}, ${ctx.now}, ${tx.json(effect)}, ${executedAudit[0]?.id ?? null})
    `;

    await tx`
      update action_proposals
         set status = 'reversed',
             result = ${tx.json({ ...row.result, reversal: { ...effect, reason: ctx.reason, reversedAt: ctx.now.toISOString(), reversedByUserId: input.userId, policy: record } })}
       where id = ${row.id}
    `;

    await tx`
      insert into audit_events (
        organization_id, actor, action, entity_type, entity_id, before, after,
        occurred_at, model_id, tool_calls, idempotency_key, reversal_of
      ) values (
        ${input.organizationId},
        ${tx.json({ kind: 'human', userId: input.userId })},
        'proposal.reversed',
        'action_proposal',
        ${row.id},
        ${tx.json({ status: 'executed', result: row.result })},
        ${tx.json({ ...effect, reason: ctx.reason, policy: record })},
        ${ctx.now},
        null,
        ${tx.json([{ tool: 'reversal', action: row.action }])},
        ${`proposal:${row.id}:reverse`},
        ${executedAudit[0]?.id ?? null}
      )
    `;

    return { status: 'reversed', proposalId: row.id, effect, confirmed: false, policy: record };
  });

  if (outcome.status !== 'reversed') return outcome;
  if (pending.readback === null) throw new Error('reversal committed without a read-back — refusing to report success');

  // Read the reversal back, exactly like the executor does for the forward write.
  const confirmed = await pending.readback();

  await sql`
    update action_proposals
       set result = jsonb_set(result, '{reversal,confirmed}', ${sql.json(confirmed)}::jsonb)
     where id = ${outcome.proposalId}
  `;

  return { ...outcome, confirmed };
}
