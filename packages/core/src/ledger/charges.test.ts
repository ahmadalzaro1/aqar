import { generateMonthlyCharges } from './index.js';
import { makeCharge, makeLease } from './factories.test-helpers.js';

describe('generateMonthlyCharges', () => {
  it('charges full rent for a month fully inside the term', () => {
    const charges = generateMonthlyCharges([makeLease()], '2026-03', []);
    expect(charges).toEqual([
      {
        id: 'lease-a:2026-03:rent',
        leaseId: 'lease-a',
        period: '2026-03',
        kind: 'rent',
        amountFils: 300000,
        dueDateISO: '2026-03-05',
        proratedDays: null,
      },
    ]);
  });

  it('prorates the first month by inclusive covered days (floor)', () => {
    // March has 31 days; lease starts on the 16th -> 16 covered days.
    const lease = makeLease({ startISO: '2026-03-16' });
    const [charge] = generateMonthlyCharges([lease], '2026-03', []);
    expect(charge?.amountFils).toBe(154838); // floor(300000 * 16 / 31)
    expect(charge?.proratedDays).toBe(16);
    expect(charge?.dueDateISO).toBe('2026-03-05');
  });

  it('prorates the last month by inclusive covered days', () => {
    // April has 30 days; lease ends on the 10th -> 10 covered days.
    const lease = makeLease({ endISO: '2026-04-10' });
    const [charge] = generateMonthlyCharges([lease], '2026-04', []);
    expect(charge?.amountFils).toBe(100000);
    expect(charge?.proratedDays).toBe(10);
  });

  it('prorates a single-month lease across the whole month span', () => {
    const lease = makeLease({ startISO: '2026-04-10', endISO: '2026-04-20' });
    const [charge] = generateMonthlyCharges([lease], '2026-04', []);
    expect(charge?.amountFils).toBe(110000); // 11 days of 30
    expect(charge?.proratedDays).toBe(11);
  });

  it('uses the real February length in leap years', () => {
    const lease = makeLease({ startISO: '2028-02-01', endISO: '2028-02-15' });
    const [charge] = generateMonthlyCharges([lease], '2028-02', []);
    expect(charge?.proratedDays).toBe(15);
    expect(charge?.amountFils).toBe(155172); // floor(300000 * 15 / 29)
    expect(charge?.dueDateISO).toBe('2028-02-05');
  });

  it('does not prorate a year-long lease month', () => {
    const lease = makeLease({ startISO: '2026-01-01', endISO: '2026-12-31' });
    const [charge] = generateMonthlyCharges([lease], '2026-07', []);
    expect(charge?.proratedDays).toBeNull();
    expect(charge?.amountFils).toBe(300000);
  });

  it('ignores leases that do not intersect the period', () => {
    const ended = makeLease({ leaseId: 'past', startISO: '2025-01-01', endISO: '2025-12-31' });
    const future = makeLease({ leaseId: 'later', startISO: '2026-05-01', endISO: '2027-05-01' });
    expect(generateMonthlyCharges([ended, future], '2026-03', [])).toEqual([]);
  });

  it('includes active and upcoming leases, excludes ended and cancelled', () => {
    const leases = [
      makeLease({ leaseId: 'active', status: 'active' }),
      makeLease({ leaseId: 'upcoming', status: 'upcoming' }),
      makeLease({ leaseId: 'ended', status: 'ended' }),
      makeLease({ leaseId: 'cancelled', status: 'cancelled' }),
    ];
    const ids = generateMonthlyCharges(leases, '2026-03', []).map((c) => c.leaseId);
    expect(ids).toEqual(['active', 'upcoming']);
  });

  it('skips lease+period+kind already present, regardless of its id', () => {
    const existing = [
      makeCharge({ id: 'legacy-id', leaseId: 'lease-a', period: '2026-03', kind: 'rent' }),
    ];
    expect(generateMonthlyCharges([makeLease()], '2026-03', existing)).toEqual([]);
  });

  it('does not let a non-rent charge block the rent charge', () => {
    const existing = [
      makeCharge({
        id: 'svc',
        leaseId: 'lease-a',
        period: '2026-03',
        kind: 'service',
        amountFils: 5000,
      }),
    ];
    const charges = generateMonthlyCharges([makeLease()], '2026-03', existing);
    expect(charges.map((c) => c.id)).toEqual(['lease-a:2026-03:rent']);
  });

  it('is idempotent when its own output is fed back as existing', () => {
    const leases = [
      makeLease({ leaseId: 'a' }),
      makeLease({ leaseId: 'b', startISO: '2026-03-20' }),
    ];
    const first = generateMonthlyCharges(leases, '2026-03', []);
    expect(first).toHaveLength(2);
    expect(generateMonthlyCharges(leases, '2026-03', first)).toEqual([]);
    const again = generateMonthlyCharges(leases, '2026-03', [...first, ...first]);
    expect(again).toEqual([]);
  });

  it('is invariant under lease input reordering', () => {
    const leases = [
      makeLease({ leaseId: 'c', rentFils: 111000 }),
      makeLease({ leaseId: 'a', rentFils: 222000 }),
      makeLease({ leaseId: 'b', rentFils: 333000, endISO: '2026-03-09' }),
    ];
    const forward = generateMonthlyCharges(leases, '2026-03', []);
    const reversed = generateMonthlyCharges([...leases].reverse(), '2026-03', []);
    expect(reversed).toEqual(forward);
    expect(forward.map((c) => c.id)).toEqual([
      'a:2026-03:rent',
      'b:2026-03:rent',
      'c:2026-03:rent',
    ]);
  });

  it('places the due date on the lease dueDay within the period month', () => {
    const lease = makeLease({ dueDay: 28 });
    const [charge] = generateMonthlyCharges([lease], '2026-02', []);
    expect(charge?.dueDateISO).toBe('2026-02-28');
  });

  it('keeps a zero-rent lease as a zero-fils charge', () => {
    const lease = makeLease({ rentFils: 0 });
    const [charge] = generateMonthlyCharges([lease], '2026-03', []);
    expect(charge?.amountFils).toBe(0);
    expect(charge?.proratedDays).toBeNull();
  });

  it('handles an empty lease list', () => {
    expect(generateMonthlyCharges([], '2026-03', [])).toEqual([]);
  });
});
