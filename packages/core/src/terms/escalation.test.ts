import type { LeaseMoneyTerms } from '@aqar/contracts';
import { escalationSchedule, escalationStepFils, rentForPeriod } from './escalation.js';

function terms(overrides: Partial<LeaseMoneyTerms> = {}): LeaseMoneyTerms {
  return {
    leaseId: 'lease-1',
    rentFils: 200_000,
    depositFils: 200_000,
    dueDay: 1,
    startISO: '2026-01-01',
    endISO: '2028-12-31',
    lateFeeRule: null,
    escalationRule: { kind: 'percent', basisPoints: 500, everyMonths: 12 },
    status: 'active',
    ...overrides,
  };
}

describe('escalationStepFils', () => {
  it('computes a percent step from the base rent, floored', () => {
    expect(
      escalationStepFils(200_000, { kind: 'percent', basisPoints: 500, everyMonths: 12 }),
    ).toBe(10_000);
    expect(
      escalationStepFils(100_000, { kind: 'percent', basisPoints: 333, everyMonths: 12 }),
    ).toBe(3_330);
  });

  it('returns zero for a none rule and the amount for a flat rule', () => {
    expect(escalationStepFils(200_000, { kind: 'none' })).toBe(0);
    expect(escalationStepFils(200_000, { kind: 'flat', amountFils: 25_000, everyMonths: 6 })).toBe(
      25_000,
    );
  });
});

describe('escalationSchedule', () => {
  it('is a non-compounding annual schedule of the requested length', () => {
    const schedule = escalationSchedule(
      200_000,
      { kind: 'percent', basisPoints: 500, everyMonths: 12 },
      25,
    );
    expect(schedule).toHaveLength(25);
    expect(schedule[0]).toBe(200_000);
    expect(schedule[11]).toBe(200_000);
    // month 13 (index 12) is after the first completed 12-month interval
    expect(schedule[12]).toBe(210_000);
    expect(schedule[23]).toBe(210_000);
    expect(schedule[24]).toBe(220_000);
  });

  it('does not compound: the second increase is the same fils amount, not 5% of 210000', () => {
    const schedule = escalationSchedule(
      200_000,
      { kind: 'percent', basisPoints: 500, everyMonths: 12 },
      37,
    );
    expect(schedule[36]).toBe(230_000);
  });

  it('applies a flat step at each completed interval', () => {
    const schedule = escalationSchedule(
      200_000,
      { kind: 'flat', amountFils: 25_000, everyMonths: 6 },
      13,
    );
    expect(schedule[5]).toBe(200_000);
    expect(schedule[6]).toBe(225_000);
    expect(schedule[12]).toBe(250_000);
  });

  it('is constant for a none rule and empty for zero months', () => {
    expect(escalationSchedule(150_000, { kind: 'none' }, 3)).toEqual([150_000, 150_000, 150_000]);
    expect(escalationSchedule(150_000, { kind: 'none' }, 0)).toEqual([]);
  });

  it('rejects invalid inputs', () => {
    expect(() => escalationSchedule(-1, { kind: 'none' }, 1)).toThrow(RangeError);
    expect(() => escalationSchedule(1000, { kind: 'none' }, -1)).toThrow(RangeError);
    expect(() =>
      escalationSchedule(1000, { kind: 'percent', basisPoints: 10001, everyMonths: 12 }, 1),
    ).toThrow(RangeError);
    expect(() =>
      escalationSchedule(1000, { kind: 'flat', amountFils: 10, everyMonths: 0 }, 1),
    ).toThrow(RangeError);
  });
});

describe('rentForPeriod', () => {
  it('uses the completed intervals between lease start and the period first day', () => {
    const lease = terms();
    expect(rentForPeriod(lease, '2026-01')).toBe(200_000);
    expect(rentForPeriod(lease, '2026-12')).toBe(200_000);
    expect(rentForPeriod(lease, '2027-01')).toBe(210_000);
    expect(rentForPeriod(lease, '2028-01')).toBe(220_000);
    expect(rentForPeriod(lease, '2028-02')).toBe(220_000);
  });

  it('clamps periods before the lease start to the base rent', () => {
    expect(rentForPeriod(terms(), '2025-06')).toBe(200_000);
  });

  it('returns the base rent for a none rule and respects flat rules', () => {
    expect(rentForPeriod(terms({ escalationRule: { kind: 'none' } }), '2030-01')).toBe(200_000);
    expect(
      rentForPeriod(
        terms({ escalationRule: { kind: 'flat', amountFils: 25_000, everyMonths: 6 } }),
        '2026-07',
      ),
    ).toBe(225_000);
  });

  it('rejects a malformed period', () => {
    expect(() => rentForPeriod(terms(), '2026-13')).toThrow(RangeError);
    expect(() => rentForPeriod(terms(), '2026-1')).toThrow(RangeError);
  });
});
