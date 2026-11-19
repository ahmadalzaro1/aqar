import type { AgingBucket, IsoDate } from '@aqar/contracts';
import { agingBucketFor, AGING_BUCKETS, agingReport } from './index.js';
import { makeAllocation, makeCharge } from './factories.test-helpers.js';

const charge = makeCharge({ id: 'c1', amountFils: 100000, dueDateISO: '2026-03-05' });

describe('agingBucketFor', () => {
  it('maps day counts to bucket boundaries', () => {
    expect(agingBucketFor(-10)).toBe('current');
    expect(agingBucketFor(0)).toBe('current');
    expect(agingBucketFor(1)).toBe('d0_30');
    expect(agingBucketFor(30)).toBe('d0_30');
    expect(agingBucketFor(31)).toBe('d31_60');
    expect(agingBucketFor(60)).toBe('d31_60');
    expect(agingBucketFor(61)).toBe('d61_90');
    expect(agingBucketFor(90)).toBe('d61_90');
    expect(agingBucketFor(91)).toBe('d90_plus');
    expect(agingBucketFor(4000)).toBe('d90_plus');
  });
});

describe('agingReport', () => {
  it('keeps a not-yet-due balance in current', () => {
    const report = agingReport([charge], [], '2026-03-05');
    expect(report.totalFils).toBe(100000);
    expect(report.buckets).toEqual({ current: 100000, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toEqual({
      chargeId: 'c1',
      leaseId: 'lease-a',
      period: '2026-03',
      dueDateISO: '2026-03-05',
      balanceFils: 100000,
      daysPastDue: 0,
      bucket: 'current',
    });
  });

  it('places balances at each boundary date', () => {
    const cases: Array<[IsoDate, AgingBucket]> = [
      ['2026-03-06', 'd0_30'],
      ['2026-04-04', 'd0_30'],
      ['2026-04-05', 'd31_60'],
      ['2026-05-04', 'd31_60'],
      ['2026-05-05', 'd61_90'],
      ['2026-06-03', 'd61_90'],
      ['2026-06-04', 'd90_plus'],
    ];
    for (const [asOfISO, bucket] of cases) {
      const report = agingReport([charge], [], asOfISO);
      expect(report.rows[0]?.bucket).toBe(bucket);
      expect(report.buckets[bucket]).toBe(100000);
    }
  });

  it('omits settled charges and reduces partially paid balances', () => {
    const paid = makeCharge({ id: 'paid', amountFils: 50000, dueDateISO: '2026-03-01' });
    const allocations = [
      makeAllocation('p1', 'paid', 50000),
      makeAllocation('p2', 'c1', 40000),
    ];
    const report = agingReport([charge, paid], allocations, '2026-04-05');
    expect(report.rows.map((r) => r.chargeId)).toEqual(['c1']);
    expect(report.rows[0]?.balanceFils).toBe(60000);
    expect(report.buckets.d31_60).toBe(60000);
    expect(report.totalFils).toBe(60000);
  });

  it('sums rows into buckets and buckets into the total', () => {
    const charges = [
      makeCharge({ id: 'a', amountFils: 1000, dueDateISO: '2026-03-01' }),
      makeCharge({ id: 'b', amountFils: 2000, dueDateISO: '2026-03-02' }),
      makeCharge({ id: 'c', amountFils: 4000, dueDateISO: '2025-11-01' }),
    ];
    const report = agingReport(charges, [], '2026-03-25');
    const bucketSum = AGING_BUCKETS.reduce((sum, bucket) => sum + report.buckets[bucket], 0);
    const rowSum = report.rows.reduce((sum, row) => sum + row.balanceFils, 0);
    expect(bucketSum).toBe(7000);
    expect(rowSum).toBe(7000);
    expect(report.totalFils).toBe(7000);
    expect(report.buckets.d0_30).toBe(3000);
    expect(report.buckets.d90_plus).toBe(4000);
  });

  it('lists rows oldest due date first', () => {
    const charges = [
      makeCharge({ id: 'new', dueDateISO: '2026-03-20' }),
      makeCharge({ id: 'old', dueDateISO: '2026-01-20' }),
    ];
    const report = agingReport(charges, [], '2026-03-25');
    expect(report.rows.map((r) => r.chargeId)).toEqual(['old', 'new']);
  });

  it('is empty when nothing is owed', () => {
    const report = agingReport([], [], '2026-03-25');
    expect(report.rows).toEqual([]);
    expect(report.totalFils).toBe(0);
    expect(report.asOfISO).toBe('2026-03-25');
  });

  it('only ever moves a balance to an equal or older bucket as the date advances', () => {
    let previousIndex = -1;
    const dates: readonly IsoDate[] = [
      '2026-03-01',
      '2026-03-05',
      '2026-03-06',
      '2026-04-05',
      '2026-05-05',
      '2026-06-04',
    ];
    for (const asOfISO of dates) {
      const report = agingReport([charge], [], asOfISO);
      const bucket = report.rows[0]?.bucket ?? 'current';
      const index = AGING_BUCKETS.indexOf(bucket);
      expect(index).toBeGreaterThanOrEqual(previousIndex);
      previousIndex = index;
    }
  });
});
