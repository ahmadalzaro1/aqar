import type { EscalationRule, LeaseMoneyTerms, Period } from '@aqar/contracts';
import { assertNonNegativeInteger, assertPositiveInteger, mulDivFloor, parseIsoDate } from './internal.js';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MAX_BASIS_POINTS = 10000;

/**
 * DESIGN CHOICE — SIMPLE (non-compounding) escalation.
 *
 * Every increase is computed from the ORIGINAL base rent at lease start, never
 * from the previously escalated rent: an increase adds
 * `floor(base * basisPoints / 10000)` fils (percent rule) or `amountFils`
 * fils (flat rule) once per completed `everyMonths` interval. Landlords in
 * Jordan typically negotiate "5% per year on the original rent"; compounding
 * is not the market convention and would silently inflate long leases.
 */
export function escalationStepFils(baseRentFils: number, rule: EscalationRule): number {
  assertNonNegativeInteger(baseRentFils, 'baseRentFils');
  switch (rule.kind) {
    case 'none':
      return 0;
    case 'percent': {
      const basisPoints = assertNonNegativeInteger(rule.basisPoints, 'rule.basisPoints');
      if (basisPoints > MAX_BASIS_POINTS) {
        throw new RangeError(`rule.basisPoints must be <= ${String(MAX_BASIS_POINTS)}`);
      }
      assertPositiveInteger(rule.everyMonths, 'rule.everyMonths');
      return mulDivFloor(baseRentFils, basisPoints, MAX_BASIS_POINTS);
    }
    case 'flat': {
      assertPositiveInteger(rule.everyMonths, 'rule.everyMonths');
      return assertNonNegativeInteger(rule.amountFils, 'rule.amountFils');
    }
    default: {
      const unreachable: never = rule;
      throw new RangeError(`unsupported escalation rule: ${String(unreachable)}`);
    }
  }
}

function intervalMonths(rule: EscalationRule): number {
  return rule.kind === 'none' ? 1 : assertPositiveInteger(rule.everyMonths, 'rule.everyMonths');
}

function rentAfterIntervals(baseRentFils: number, stepFils: number, intervals: number): number {
  const rent = baseRentFils + stepFils * intervals;
  if (!Number.isSafeInteger(rent)) {
    throw new RangeError('escalated rent exceeds the safe integer range');
  }
  return rent;
}

/**
 * Month-by-month rent schedule for `months` months starting at lease month 0.
 * Month index `i` sits after `floor(i / everyMonths)` completed intervals, so
 * an annual rule raises the rent on the 13th month (the first anniversary).
 * Length is exactly `months`; the sequence is nondecreasing.
 */
export function escalationSchedule(
  baseRentFils: number,
  rule: EscalationRule,
  months: number,
): number[] {
  assertNonNegativeInteger(months, 'months');
  const step = escalationStepFils(baseRentFils, rule);
  const every = intervalMonths(rule);
  const schedule: number[] = [];
  for (let index = 0; index < months; index += 1) {
    const intervals = rule.kind === 'none' ? 0 : Math.floor(index / every);
    schedule.push(rentAfterIntervals(baseRentFils, step, intervals));
  }
  return schedule;
}

/**
 * Base rent escalated by the number of completed `everyMonths` intervals
 * between the lease start and the FIRST DAY of `period`. Periods before the
 * lease start use the base rent (no negative escalation).
 */
export function rentForPeriod(terms: LeaseMoneyTerms, period: Period): number {
  const match = MONTH_PATTERN.exec(period);
  if (match === null) {
    throw new RangeError(`period must be YYYY-MM (received ${period})`);
  }
  const periodYear = Number(match[1] ?? '');
  const periodMonth = Number(match[2] ?? '');
  const startISO = parseIsoDate(terms.startISO, 'terms.startISO');
  const startYear = Number(startISO.slice(0, 4));
  const startMonth = Number(startISO.slice(5, 7));

  const monthsElapsed = (periodYear - startYear) * 12 + (periodMonth - startMonth);
  const rule = terms.escalationRule;
  const step = escalationStepFils(terms.rentFils, rule);
  if (rule.kind === 'none' || monthsElapsed <= 0) {
    return terms.rentFils;
  }
  const intervals = Math.floor(monthsElapsed / intervalMonths(rule));
  return rentAfterIntervals(terms.rentFils, step, intervals);
}
