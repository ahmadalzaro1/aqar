import type { LateFeeRule } from '@aqar/contracts';
import { computeLateFee } from './index.js';
import { makeCharge } from './factories.test-helpers.js';

const charge = makeCharge({ id: 'c1', amountFils: 500000, dueDateISO: '2026-03-05' });

const flat = (amountFils: number, graceDays = 0, capFils: number | null = null): LateFeeRule => ({
  kind: 'flat',
  amountFils,
  graceDays,
  capFils,
});

const percent = (
  basisPoints: number,
  graceDays = 0,
  capFils: number | null = null,
): LateFeeRule => ({
  kind: 'percent',
  basisPoints,
  graceDays,
  capFils,
});

describe('computeLateFee', () => {
  it('is zero before the due date', () => {
    expect(computeLateFee(flat(5000), charge, 500000, '2026-03-04')).toBe(0);
    expect(computeLateFee(percent(500), charge, 500000, '2026-03-05')).toBe(0);
  });

  it('is zero through the grace period and applies on the next day', () => {
    const rule = flat(5000, 5);
    expect(computeLateFee(rule, charge, 500000, '2026-03-10')).toBe(0); // exactly 5 days late
    expect(computeLateFee(rule, charge, 500000, '2026-03-11')).toBe(5000);
  });

  it('charges a flat amount', () => {
    expect(computeLateFee(flat(7500), charge, 500000, '2026-03-20')).toBe(7500);
  });

  it('charges basis points on the outstanding balance', () => {
    // hand-computed: 500 bps (5%) of 200000 fils = 10000 fils
    expect(computeLateFee(percent(500), charge, 200000, '2026-03-20')).toBe(10000);
  });

  it('floors percent fees instead of rounding up', () => {
    // floor(1001 * 333 / 10000) = floor(33.3333) = 33
    expect(computeLateFee(percent(333), charge, 1001, '2026-03-20')).toBe(33);
  });

  it('applies a cap when present and never exceeds it', () => {
    expect(computeLateFee(percent(500, 0, 4000), charge, 200000, '2026-03-20')).toBe(4000);
    expect(computeLateFee(flat(9000, 0, 3000), charge, 200000, '2026-03-20')).toBe(3000);
    expect(computeLateFee(percent(500, 0, 50000), charge, 200000, '2026-03-20')).toBe(10000);
  });

  it('computes on outstanding only, not the original charge amount', () => {
    expect(computeLateFee(percent(500), charge, 100000, '2026-03-20')).toBe(5000);
    expect(computeLateFee(percent(500), charge, 0, '2026-03-20')).toBe(0);
  });

  it('owes nothing once the charge is settled', () => {
    expect(computeLateFee(flat(5000), charge, 0, '2026-09-20')).toBe(0);
  });
});
