// Late fees: computed on the OUTSTANDING balance only, never on the original charge.
import type { Charge, IsoDate, LateFeeRule } from '@aqar/contracts';
import { daysBetween } from './iso.js';
import { assertFils, mulDivFloor } from './fils.js';

/**
 * Zero until `asOfISO` is strictly past dueDate + graceDays. Flat rules charge
 * `amountFils`; percent rules charge floor(outstanding * basisPoints / 10000).
 * `capFils` clamps the result when non-null. A settled charge owes no fee.
 */
export function computeLateFee(
  rule: LateFeeRule,
  charge: Charge,
  outstandingFils: number,
  asOfISO: IsoDate,
): number {
  assertFils(outstandingFils);
  if (outstandingFils === 0) return 0;

  const daysLate = daysBetween(charge.dueDateISO, asOfISO);
  if (daysLate <= rule.graceDays) return 0;

  const raw =
    rule.kind === 'flat' ? rule.amountFils : mulDivFloor(outstandingFils, rule.basisPoints, 10000);
  const capped = rule.capFils === null ? raw : Math.min(raw, rule.capFils);
  return Math.min(capped, Number.MAX_SAFE_INTEGER);
}
