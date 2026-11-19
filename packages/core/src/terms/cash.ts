import { assertNonNegativeInteger, mulDivFloor } from './internal.js';

const MAX_BASIS_POINTS = 10000;

/**
 * Deposit owed back to the tenant: deposit minus the sum of deductions.
 * Throws when any deduction is negative or the deductions exceed the deposit —
 * a refund can never be negative and never silently truncates.
 */
export function depositRefund(depositFils: number, deductionsFils: readonly number[]): number {
  const deposit = assertNonNegativeInteger(depositFils, 'depositFils');
  let totalDeductions = 0;
  for (const deduction of deductionsFils) {
    assertNonNegativeInteger(deduction, 'deductionFils');
    totalDeductions += deduction;
    if (!Number.isSafeInteger(totalDeductions)) {
      throw new RangeError('total deductions exceed the safe integer range');
    }
  }
  if (totalDeductions > deposit) {
    throw new RangeError(
      `deductions (${String(totalDeductions)} fils) exceed the deposit (${String(deposit)} fils)`,
    );
  }
  return deposit - totalDeductions;
}

/** Management fee in fils: `floor(collectedFils * basisPoints / 10000)`. */
export function managementFee(collectedFils: number, basisPoints: number): number {
  const collected = assertNonNegativeInteger(collectedFils, 'collectedFils');
  const bps = assertNonNegativeInteger(basisPoints, 'basisPoints');
  if (bps > MAX_BASIS_POINTS) {
    throw new RangeError(`basisPoints must be <= ${String(MAX_BASIS_POINTS)}`);
  }
  return mulDivFloor(collected, bps, MAX_BASIS_POINTS);
}

/**
 * Owner distribution waterfall: gross collections less the management fee,
 * property expenses and the reserve top-up. Throws instead of paying a
 * negative amount — a negative result means the fee/expense inputs are wrong
 * or the owner must fund a shortfall, which is a separate decision.
 */
export function distributionWaterfall(
  grossCollectedFils: number,
  feeFils: number,
  expensesFils: number,
  reserveFils: number,
): number {
  const gross = assertNonNegativeInteger(grossCollectedFils, 'grossCollectedFils');
  const fee = assertNonNegativeInteger(feeFils, 'feeFils');
  const expenses = assertNonNegativeInteger(expensesFils, 'expensesFils');
  const reserve = assertNonNegativeInteger(reserveFils, 'reserveFils');
  const net = gross - fee - expenses - reserve;
  if (net < 0) {
    throw new RangeError(
      `waterfall is negative: gross ${String(gross)} - fee ${String(fee)} - expenses ${String(
        expenses,
      )} - reserve ${String(reserve)} = ${String(net)} fils`,
    );
  }
  return net;
}
