import type { Allocation, ChequeStatus } from '@aqar/contracts';
import { assertPositiveInteger } from './internal.js';

export type ChequeEvent = 'deposit' | 'clear' | 'bounce';

/**
 * Cheque lifecycle: received -> deposited -> cleared, or deposited -> bounced.
 * A bounced cheque is terminal; re-depositing is a new cheque record, never a
 * resurrection of the old one.
 */
const TRANSITIONS: Readonly<
  Record<ChequeStatus, Readonly<Record<ChequeEvent, ChequeStatus | null>>>
> = {
  received: { deposit: 'deposited', clear: null, bounce: null },
  deposited: { deposit: null, clear: 'cleared', bounce: 'bounced' },
  cleared: { deposit: null, clear: null, bounce: null },
  bounced: { deposit: null, clear: null, bounce: null },
};

export function chequeTransition(current: ChequeStatus, event: ChequeEvent): ChequeStatus {
  const next = TRANSITIONS[current][event];
  if (next === null) {
    throw new RangeError(`invalid cheque transition: ${current} + ${event}`);
  }
  return next;
}

export interface ChequeReversalEntry {
  readonly chargeId: string;
  readonly amountFils: number;
}

/**
 * Plan the ledger reversal of a bounced cheque: every allocation made from
 * that cheque is undone and the charge is re-opened. Amounts are aggregated per
 * charge (first-appearance order) so a charge covered by several allocations is
 * re-opened once for its full reversed amount. The ledger engine applies it.
 */
export function chequeBounceReversal(allocations: readonly Allocation[]): ChequeReversalEntry[] {
  const order: string[] = [];
  const totals = new Map<string, number>();
  for (const allocation of allocations) {
    if (allocation.chargeId.length === 0) {
      throw new RangeError('allocation.chargeId must not be empty');
    }
    assertPositiveInteger(allocation.amountFils, 'allocation.amountFils');
    const existing = totals.get(allocation.chargeId);
    if (existing === undefined) {
      order.push(allocation.chargeId);
      totals.set(allocation.chargeId, allocation.amountFils);
      continue;
    }
    const next = existing + allocation.amountFils;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError('reversed amount exceeds the safe integer range');
    }
    totals.set(allocation.chargeId, next);
  }
  return order.map((chargeId) => ({ chargeId, amountFils: totals.get(chargeId) ?? 0 }));
}
