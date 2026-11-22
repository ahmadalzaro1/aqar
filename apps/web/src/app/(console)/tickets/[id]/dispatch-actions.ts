'use server';

// The ONLY write path for dispatching a ticket to a vendor (M5/M6).
//
// The shape of the state machine, in one place because it is the thing that
// stops a work order from being both "awaiting approval" and "in progress":
//
//   triaged ──offer(within ceiling)──▶ dispatched ──accept──▶ in_progress ──complete──▶ completed
//      └────offer(over ceiling)────▶ draft work order ──approve──▶ dispatched
//
// Every rule that decides yes/no lives in @aqar/core (pure, tested); this file
// only persists the decision and appends the audit row.
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { TransactionSql } from 'postgres';
import { sql } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { approvalForNte, completionOutcome, slaDueDates, toFils, type Severity } from '@aqar/core';
import type { ServiceStandard } from '@aqar/contracts';
import { dispatchContext, serviceStandardFor, spendPolicy } from './dispatch-queries';

export type DispatchResult =
  | { readonly status: 'ok'; readonly workOrderId: string; readonly dispatchId: string | null }
  | { readonly status: 'needs_approval'; readonly workOrderId: string }
  | { readonly status: 'invalid'; readonly detail: string }
  | { readonly status: 'conflict'; readonly detail: string }
  | { readonly status: 'unauthorized' };

function parseJod(raw: string): number | null {
  try {
    return toFils(raw.trim());
  } catch {
    return null;
  }
}

/** The transaction handle postgres.js hands a `sql.begin` callback. */
type Tx = TransactionSql<Record<string, unknown>>;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/** One clock per ticket. Created lazily so a dispatch always has something to breach. */
async function ensureClock(
  tx: Tx,
  orgId: string,
  ticketId: string,
  severity: Severity,
  openedAtISO: string,
  standard: ServiceStandard,
): Promise<void> {
  const due = slaDueDates(standard, severity, openedAtISO);
  await tx`
    INSERT INTO sla_clocks
      (id, organization_id, ticket_id, severity, response_due_at, resolution_due_at)
    VALUES
      (${randomUUID()}, ${orgId}, ${ticketId}, ${severity},
       ${due.responseDueISO}, ${due.resolutionDueISO})
    ON CONFLICT (ticket_id) DO NOTHING`;
}

async function audit(
  tx: Tx,
  orgId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  after: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  await tx`
    INSERT INTO audit_events
      (id, organization_id, actor, action, entity_type, entity_id, before, after,
       model_id, prompt_version, confidence, idempotency_key, occurred_at)
    VALUES
      (${randomUUID()}, ${orgId}, ${JSON.stringify({ kind: 'user', id: userId })}::jsonb,
       ${action}, ${entityType}, ${entityId}, NULL, ${JSON.stringify(after)}::jsonb,
       NULL, NULL, NULL, ${idempotencyKey}, ${new Date()})`;
}

/**
 * Offer a job to a vendor.
 *
 * Within the org's ceiling the offer goes out immediately; above it — or with no
 * ceiling stated at all — the work order is created as a draft and nothing is
 * sent. The vendor is never told about a job the agency has not authorised.
 */
export async function offerDispatch(input: {
  readonly ticketId: string;
  readonly vendorId: string;
  readonly scopeMd: string;
  /** ceiling in JOD as typed by a human, e.g. '75.500' */
  readonly nteJod: string;
}): Promise<DispatchResult> {
  const user = await getSessionUser();
  if (user === null) return { status: 'unauthorized' };
  const orgId = user.orgId;

  const scope = input.scopeMd.trim();
  if (scope.length < 8) return { status: 'invalid', detail: 'scope_too_short' };
  const nteFils = parseJod(input.nteJod);
  if (nteFils === null) return { status: 'invalid', detail: 'nte_not_a_number' };

  const ctx = await dispatchContext(orgId, input.ticketId);
  if (ctx === null) return { status: 'invalid', detail: 'ticket_not_found' };
  if (ctx.status === 'completed' || ctx.status === 'closed' || ctx.status === 'cancelled') {
    return { status: 'conflict', detail: 'ticket_already_closed' };
  }

  const [policy, standard] = await Promise.all([spendPolicy(orgId), serviceStandardFor(orgId)]);
  // Above the org's hard ceiling this is not a "needs approval" job — no one in
  // the console can authorise it, so refuse before anything is written.
  if (nteFils > policy.nteCeilingFils) {
    return { status: 'invalid', detail: 'above_policy_ceiling' };
  }
  const decision = approvalForNte({ nteFils, approvalLimitFils: policy.autoApproveUnderFils });
  const workOrderId = randomUUID();
  const dispatchId = decision.requiresApproval ? null : randomUUID();

  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;

      const open = await tx`
        SELECT id FROM work_orders
        WHERE ticket_id = ${input.ticketId} AND organization_id = ${orgId}
          AND status NOT IN ('completed', 'cancelled')
        LIMIT 1`;
      if (open[0] !== undefined) {
        return { status: 'conflict' as const, detail: 'work_order_open' };
      }

      await ensureClock(tx, orgId, input.ticketId, ctx.severity, ctx.openedAtISO, standard);

      await tx`
        INSERT INTO work_orders
          (id, organization_id, ticket_id, vendor_id, status, scope_md, nte_fils,
           created_by_user_id, approved_at)
        VALUES
          (${workOrderId}, ${orgId}, ${input.ticketId}, ${input.vendorId},
           ${decision.requiresApproval ? 'draft' : 'approved'}::work_order_status,
           ${scope}, ${nteFils}, ${user.id},
           ${decision.requiresApproval ? null : new Date()})`;

      if (dispatchId !== null) {
        await tx`
          INSERT INTO dispatches
            (id, organization_id, ticket_id, vendor_id, status, offered_at)
          VALUES
            (${dispatchId}, ${orgId}, ${input.ticketId}, ${input.vendorId},
             'offered'::dispatch_status, ${new Date()})`;
        await tx`
          UPDATE tickets SET status = 'dispatched', updated_at = ${new Date()}
          WHERE id = ${input.ticketId} AND organization_id = ${orgId}
            AND status IN ('new', 'triaged', 'awaiting_tenant', 'approved')`;
      }

      await audit(
        tx,
        orgId,
        user.id,
        decision.requiresApproval ? 'work_order.offer.await_approval' : 'work_order.offer',
        'work_order',
        workOrderId,
        {
          ticketId: input.ticketId,
          vendorId: input.vendorId,
          nteFils,
          autoApproveUnderFils: policy.autoApproveUnderFils,
          nteCeilingFils: policy.nteCeilingFils,
          reason: decision.reason,
        },
        `work_order.offer:${input.ticketId}:${input.vendorId}`,
      );

      return decision.requiresApproval
        ? { status: 'needs_approval' as const, workOrderId }
        : { status: 'ok' as const, workOrderId, dispatchId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: 'conflict', detail: 'already_offered' };
    throw error;
  } finally {
    revalidatePath(`/tickets/${input.ticketId}`);
  }
}

/** Sign off a draft work order, then send the offer. The human is the gate. */
export async function approveWorkOrder(workOrderId: string): Promise<DispatchResult> {
  const user = await getSessionUser();
  if (user === null) return { status: 'unauthorized' };
  const orgId = user.orgId;

  const rows = await sql`
    SELECT id, ticket_id, vendor_id, status FROM work_orders
    WHERE id = ${workOrderId} AND organization_id = ${orgId} LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return { status: 'invalid', detail: 'work_order_not_found' };
  if (String(row['status']) !== 'draft') return { status: 'conflict', detail: 'not_a_draft' };
  const ticketId = String(row['ticket_id']);
  const dispatchId = randomUUID();

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    await tx`
      UPDATE work_orders SET status = 'approved', approved_at = ${new Date()},
        updated_at = ${new Date()}
      WHERE id = ${workOrderId} AND organization_id = ${orgId} AND status = 'draft'`;
    await tx`
      INSERT INTO dispatches (id, organization_id, ticket_id, vendor_id, status, offered_at)
      VALUES (${dispatchId}, ${orgId}, ${ticketId}, ${String(row['vendor_id'])},
        'offered'::dispatch_status, ${new Date()})`;
    await tx`
      UPDATE tickets SET status = 'dispatched', updated_at = ${new Date()}
      WHERE id = ${ticketId} AND organization_id = ${orgId}
        AND status NOT IN ('completed', 'closed', 'cancelled')`;
    await audit(
      tx,
      orgId,
      user.id,
      'work_order.approve',
      'work_order',
      workOrderId,
      {
        ticketId,
      },
      `work_order.approve:${workOrderId}`,
    );
    revalidatePath(`/tickets/${ticketId}`);
    return { status: 'ok' as const, workOrderId, dispatchId };
  });
}

/** The vendor said yes: the job is now theirs and the response clock is met. */
export async function acceptDispatch(dispatchId: string): Promise<DispatchResult> {
  const user = await getSessionUser();
  if (user === null) return { status: 'unauthorized' };
  const orgId = user.orgId;

  const rows = await sql`
    SELECT id, ticket_id, vendor_id, status FROM dispatches
    WHERE id = ${dispatchId} AND organization_id = ${orgId} LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return { status: 'invalid', detail: 'dispatch_not_found' };
  if (String(row['status']) !== 'offered') return { status: 'conflict', detail: 'not_offered' };
  const ticketId = String(row['ticket_id']);

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    await tx`
      UPDATE dispatches SET status = 'accepted', accepted_at = ${new Date()},
        updated_at = ${new Date()}
      WHERE id = ${dispatchId} AND organization_id = ${orgId} AND status = 'offered'`;
    const updated = await tx`
      UPDATE work_orders SET status = 'in_progress', updated_at = ${new Date()}
      WHERE ticket_id = ${ticketId} AND organization_id = ${orgId}
        AND status IN ('approved', 'dispatched')
      RETURNING id`;
    await tx`
      UPDATE tickets SET status = 'in_progress', updated_at = ${new Date()}
      WHERE id = ${ticketId} AND organization_id = ${orgId}
        AND status NOT IN ('completed', 'closed', 'cancelled')`;
    await tx`
      UPDATE sla_clocks SET responded_at = COALESCE(responded_at, ${new Date()}),
        updated_at = ${new Date()}
      WHERE ticket_id = ${ticketId} AND organization_id = ${orgId}`;
    const workOrderId = updated[0] === undefined ? null : String(updated[0]['id']);
    await audit(
      tx,
      orgId,
      user.id,
      'dispatch.accept',
      'dispatch',
      dispatchId,
      {
        ticketId,
        workOrderId,
        vendorId: String(row['vendor_id']),
      },
      `dispatch.accept:${dispatchId}`,
    );
    revalidatePath(`/tickets/${ticketId}`);
    return { status: 'ok' as const, workOrderId: workOrderId ?? '', dispatchId };
  });
}

/** The vendor said no. The ticket returns to triage so it can be offered elsewhere. */
export async function declineDispatch(dispatchId: string, note: string): Promise<DispatchResult> {
  const user = await getSessionUser();
  if (user === null) return { status: 'unauthorized' };
  const orgId = user.orgId;

  const rows = await sql`
    SELECT id, ticket_id, vendor_id, status FROM dispatches
    WHERE id = ${dispatchId} AND organization_id = ${orgId} LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return { status: 'invalid', detail: 'dispatch_not_found' };
  if (String(row['status']) !== 'offered') return { status: 'conflict', detail: 'not_offered' };
  const ticketId = String(row['ticket_id']);

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    await tx`
      UPDATE dispatches SET status = 'declined', note = ${note.trim().slice(0, 2000)},
        updated_at = ${new Date()}
      WHERE id = ${dispatchId} AND organization_id = ${orgId} AND status = 'offered'`;
    await tx`
      UPDATE work_orders SET status = 'cancelled', updated_at = ${new Date()}
      WHERE ticket_id = ${ticketId} AND organization_id = ${orgId}
        AND status IN ('approved', 'dispatched')`;
    const live = await tx`
      SELECT id FROM dispatches
      WHERE ticket_id = ${ticketId} AND organization_id = ${orgId}
        AND status IN ('offered', 'accepted') LIMIT 1`;
    if (live[0] === undefined) {
      await tx`
        UPDATE tickets SET status = 'triaged', updated_at = ${new Date()}
        WHERE id = ${ticketId} AND organization_id = ${orgId}
          AND status = 'dispatched'`;
    }
    await audit(
      tx,
      orgId,
      user.id,
      'dispatch.decline',
      'dispatch',
      dispatchId,
      {
        ticketId,
        vendorId: String(row['vendor_id']),
        note: note.trim().slice(0, 2000),
      },
      `dispatch.decline:${dispatchId}`,
    );
    revalidatePath(`/tickets/${ticketId}`);
    return { status: 'ok' as const, workOrderId: '', dispatchId };
  });
}

/** Record a price a vendor quoted. Recording is not selecting — that stays a human act. */
export async function recordQuote(input: {
  readonly ticketId: string;
  readonly vendorId: string;
  readonly amountJod: string;
  readonly leadTimeDays: number | null;
  readonly notes: string;
}): Promise<DispatchResult> {
  const user = await getSessionUser();
  if (user === null) return { status: 'unauthorized' };
  const orgId = user.orgId;

  const amountFils = parseJod(input.amountJod);
  if (amountFils === null) return { status: 'invalid', detail: 'amount_not_a_number' };
  const lead = input.leadTimeDays;
  if (lead !== null && (!Number.isInteger(lead) || lead < 0 || lead > 365)) {
    return { status: 'invalid', detail: 'lead_time_out_of_range' };
  }

  const ctx = await dispatchContext(orgId, input.ticketId);
  if (ctx === null) return { status: 'invalid', detail: 'ticket_not_found' };
  const quoteId = randomUUID();

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    await tx`
      INSERT INTO vendor_quotes
        (id, organization_id, ticket_id, vendor_id, amount_fils, lead_time_days,
         received_at, selected, notes)
      VALUES
        (${quoteId}, ${orgId}, ${input.ticketId}, ${input.vendorId}, ${amountFils},
         ${lead}, ${new Date()}, false, ${input.notes.trim().slice(0, 2000)})`;
    await audit(
      tx,
      orgId,
      user.id,
      'vendor_quote.record',
      'vendor_quote',
      quoteId,
      {
        ticketId: input.ticketId,
        vendorId: input.vendorId,
        amountFils,
        leadTimeDays: lead,
      },
      `vendor_quote.record:${quoteId}`,
    );
    revalidatePath(`/tickets/${input.ticketId}`);
    return { status: 'ok' as const, workOrderId: '', dispatchId: quoteId };
  });
}

/**
 * Close the job: record what it actually cost, stop the clock, and surface any
 * overage rather than absorbing it silently into the ledger.
 */
export async function completeWorkOrder(input: {
  readonly workOrderId: string;
  readonly costJod: string;
  readonly notes: string;
}): Promise<DispatchResult> {
  const user = await getSessionUser();
  if (user === null) return { status: 'unauthorized' };
  const orgId = user.orgId;

  const costFils = parseJod(input.costJod);
  if (costFils === null) return { status: 'invalid', detail: 'cost_not_a_number' };

  const rows = await sql`
    SELECT id, ticket_id, vendor_id, status, nte_fils FROM work_orders
    WHERE id = ${input.workOrderId} AND organization_id = ${orgId} LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return { status: 'invalid', detail: 'work_order_not_found' };
  if (String(row['status']) === 'completed') {
    return { status: 'conflict', detail: 'already_completed' };
  }
  const ticketId = String(row['ticket_id']);
  const nteFils = row['nte_fils'] === null ? null : Number(row['nte_fils']);
  const outcome = completionOutcome({ costFils, nteFils });

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    await tx`
      INSERT INTO completions
        (id, organization_id, ticket_id, work_order_id, completed_at, cost_fils, notes,
         tenant_confirmed, photos)
      VALUES
        (${randomUUID()}, ${orgId}, ${ticketId}, ${input.workOrderId}, ${new Date()},
         ${costFils}, ${input.notes.trim().slice(0, 4000)}, false, '[]'::jsonb)`;
    await tx`
      UPDATE work_orders SET status = 'completed', updated_at = ${new Date()}
      WHERE id = ${input.workOrderId} AND organization_id = ${orgId}`;
    await tx`
      UPDATE tickets SET status = 'completed', updated_at = ${new Date()}
      WHERE id = ${ticketId} AND organization_id = ${orgId}
        AND status NOT IN ('closed', 'cancelled')`;
    await tx`
      UPDATE sla_clocks SET resolved_at = COALESCE(resolved_at, ${new Date()}),
        updated_at = ${new Date()}
      WHERE ticket_id = ${ticketId} AND organization_id = ${orgId}`;
    await audit(
      tx,
      orgId,
      user.id,
      'work_order.complete',
      'work_order',
      input.workOrderId,
      {
        ticketId,
        costFils,
        nteFils,
        varianceFils: outcome.varianceFils,
        overNte: outcome.overNte,
      },
      `work_order.complete:${input.workOrderId}`,
    );
    revalidatePath(`/tickets/${ticketId}`);
    return { status: 'ok' as const, workOrderId: input.workOrderId, dispatchId: null };
  });
}
