// Payment allocation and derived charge status. Nothing here is stored state.
import type { Allocation, Charge, ChargeStatus, IsoDate, Payment } from '@aqar/contracts';
import { assertFils, sumFils } from './fils.js';

/** Total allocated against one charge across every payment seen. */
export function allocatedAgainst(chargeId: string, allocations: readonly Allocation[]): number {
  const amounts: number[] = [];
  for (const allocation of allocations) {
    if (allocation.chargeId === chargeId) amounts.push(allocation.amountFils);
  }
  return sumFils(amounts);
}

/** amount minus allocations, floored at zero (over-allocation never produces negative debt). */
export function outstandingFils(charge: Charge, allocations: readonly Allocation[]): number {
  const allocated = allocatedAgainst(charge.id, allocations);
  return Math.max(0, charge.amountFils - allocated);
}

interface Candidate {
  readonly charge: Charge;
  readonly outstanding: number;
}

function compareCharges(a: Candidate, b: Candidate): number {
  if (a.charge.dueDateISO !== b.charge.dueDateISO)
    return a.charge.dueDateISO < b.charge.dueDateISO ? -1 : 1;
  if (a.charge.id !== b.charge.id) return a.charge.id < b.charge.id ? -1 : 1;
  return 0;
}

/**
 * Greedy allocation, never overallocating and never touching a paid charge.
 *
 * Order: when the payment carries a trusted `referencePeriod`, that period's charges
 * come first (by due date, ties by id), then every remaining charge oldest due date
 * first. Untrusted hints (`referenceText`) are ignored by construction.
 *
 * Only NEW allocations are returned, and the payment's unapplied balance is
 * `amountFils` minus whatever was already allocated FROM THIS PAYMENT in
 * `existingAllocations`. Re-running a payment is therefore safe: feeding its own
 * output back in returns an empty list instead of spending the same money twice.
 */
export function allocatePayment(
  payment: Payment,
  charges: readonly Charge[],
  existingAllocations: readonly Allocation[],
): Allocation[] {
  assertFils(payment.amountFils);

  const byId = new Map<string, Charge>();
  for (const charge of charges) {
    if (!byId.has(charge.id)) byId.set(charge.id, charge);
  }

  const appliedByThisPayment = sumFils(
    existingAllocations
      .filter((allocation) => allocation.paymentId === payment.id)
      .map((a) => a.amountFils),
  );
  const available = Math.max(0, payment.amountFils - appliedByThisPayment);

  const candidates: Candidate[] = [];
  for (const charge of byId.values()) {
    const outstanding = outstandingFils(charge, existingAllocations);
    if (outstanding > 0) candidates.push({ charge, outstanding });
  }

  const referencePeriod = payment.referencePeriod;
  const referenced: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const candidate of candidates) {
    if (referencePeriod !== null && candidate.charge.period === referencePeriod)
      referenced.push(candidate);
    else rest.push(candidate);
  }
  referenced.sort(compareCharges);
  rest.sort(compareCharges);

  const allocations: Allocation[] = [];
  let remaining = available;
  for (const candidate of [...referenced, ...rest]) {
    if (remaining <= 0) break;
    const amountFils = Math.min(candidate.outstanding, remaining);
    if (amountFils <= 0) continue;
    allocations.push({ paymentId: payment.id, chargeId: candidate.charge.id, amountFils });
    remaining -= amountFils;
  }
  return allocations;
}

/**
 * Derived, never stored. Precedence: fully allocated -> paid; past due -> overdue;
 * any allocation -> partial; otherwise open.
 */
export function deriveChargeStatus(
  charge: Charge,
  allocations: readonly Allocation[],
  asOfISO: IsoDate,
): ChargeStatus {
  const allocated = allocatedAgainst(charge.id, allocations);
  if (allocated >= charge.amountFils) return 'paid';
  if (asOfISO > charge.dueDateISO) return 'overdue';
  if (allocated > 0) return 'partial';
  return 'open';
}
