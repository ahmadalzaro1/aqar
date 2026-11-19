import { assertNonNegativeInteger, assertPositiveInteger, mulDivFloor } from './internal.js';

/** A month never has more than 31 days; anything else is a caller bug. */
const MAX_DAYS_IN_MONTH = 31;

/**
 * Rent for a partial month: `floor(rentFils * daysCovered / daysInMonth)`.
 * Integer fils only — the division is floored once, never accumulated.
 */
export function prorateRent(rentFils: number, daysCovered: number, daysInMonth: number): number {
  assertNonNegativeInteger(rentFils, 'rentFils');
  assertNonNegativeInteger(daysCovered, 'daysCovered');
  assertPositiveInteger(daysInMonth, 'daysInMonth');
  if (daysInMonth > MAX_DAYS_IN_MONTH) {
    throw new RangeError(`daysInMonth must be <= ${String(MAX_DAYS_IN_MONTH)}`);
  }
  return mulDivFloor(rentFils, daysCovered, daysInMonth);
}
