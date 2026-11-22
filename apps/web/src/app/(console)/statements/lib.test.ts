import { describe, expect, it } from 'vitest';
import {
  computeStatement,
  distributionDrafts,
  ownerShareAmount,
  parseStatementPeriod,
  statementIdempotencyKey,
} from './lib';
import type { StatementSource } from './lib';
import type { OwnerShare } from '@aqar/contracts';

const source = (over: Partial<StatementSource> = {}): StatementSource => ({
  propertyId: 'prop-1',
  period: '2026-11',
  rentLines: [
    { leaseId: 'l1', unitLabel: '1', tenantName: 'A', billedFils: 600000, collectedFils: 600000 },
    { leaseId: 'l2', unitLabel: '2', tenantName: 'B', billedFils: 400000, collectedFils: 400000 },
  ],
  expenseLines: [{ workOrderId: 'w1', label: 'fix', completedISO: '2026-11-05', costFils: 100000 }],
  shares: [
    { ownerId: 'o1', shareBps: 6000 },
    { ownerId: 'o2', shareBps: 4000 },
  ],
  feeBasisBps: 800,
  ...over,
});

describe('parseStatementPeriod', () => {
  it('accepts YYYY-MM via the frozen contract and rejects the rest', () => {
    expect(parseStatementPeriod('2026-11')).toBe('2026-11');
    expect(parseStatementPeriod('2026-13')).toBeNull();
    expect(parseStatementPeriod('2026-1')).toBeNull();
    expect(parseStatementPeriod(undefined)).toBeNull();
  });
});

describe('statementIdempotencyKey', () => {
  it('is property:period — one statement per property+period', () => {
    expect(statementIdempotencyKey('prop-1', '2026-11')).toBe('prop-1:2026-11');
  });
});

describe('computeStatement — all money from core', () => {
  it('waterfall: collected 1,000,000 − fee 80,000 − expenses 100,000 = net 820,000', () => {
    const d = computeStatement(source());
    expect(d.blocked).toBeNull();
    expect(d.billedRentFils).toBe(1000000);
    expect(d.grossCollectedFils).toBe(1000000);
    expect(d.managementFeeFils).toBe(80000);
    expect(d.expensesFils).toBe(100000);
    expect(d.netFils).toBe(820000);
    expect(d.ownerShares.find((x) => x.ownerId === 'o1')?.amountFils).toBe(492000);
    expect(d.ownerShares.find((x) => x.ownerId === 'o2')?.amountFils).toBe(328000);
  });
  it('blocks with no-owners instead of inventing a split', () => {
    const d = computeStatement(source({ shares: [] }));
    expect(d.blocked?.code).toBe('no-owners');
    expect(d.netFils).toBeNull();
  });
  it('blocks when shares do not sum to 10000 bps', () => {
    const d = computeStatement(source({ shares: [{ ownerId: 'o1', shareBps: 9000 }] }));
    expect(d.blocked?.code).toBe('invalid-shares');
    expect(d.netFils).toBeNull();
  });
  it('blocks on shortfall — expenses beyond collected never go negative', () => {
    const d = computeStatement(
      source({
        rentLines: [
          {
            leaseId: 'l1',
            unitLabel: '1',
            tenantName: 'A',
            billedFils: 100000,
            collectedFils: 100000,
          },
        ],
        expenseLines: [
          { workOrderId: 'w1', label: 'big', completedISO: '2026-11-05', costFils: 200000 },
        ],
      }),
    );
    expect(d.blocked?.code).toBe('shortfall');
    expect(d.netFils).toBeNull();
  });
  it('largest-remainder split is exact and row-order independent', () => {
    const shares: OwnerShare[] = [
      { ownerId: 'a', shareBps: 3333 },
      { ownerId: 'b', shareBps: 3333 },
      { ownerId: 'c', shareBps: 3334 },
    ];
    const rent = [
      { leaseId: 'l1', unitLabel: '1', tenantName: 'A', billedFils: 100001, collectedFils: 100001 },
    ];
    const d1 = computeStatement(
      source({ rentLines: rent, expenseLines: [], shares, feeBasisBps: 0 }),
    );
    const d2 = computeStatement(
      source({ rentLines: rent, expenseLines: [], shares: [...shares].reverse(), feeBasisBps: 0 }),
    );
    expect(d1.netFils).toBe(100001);
    const sum = d1.ownerShares.reduce((acc, x) => acc + x.amountFils, 0);
    expect(sum).toBe(100001);
    for (const id of ['a', 'b', 'c']) {
      expect(d1.ownerShares.find((x) => x.ownerId === id)?.amountFils).toBe(
        d2.ownerShares.find((x) => x.ownerId === id)?.amountFils,
      );
    }
  });
});

describe('distributionDrafts / ownerShareAmount', () => {
  it('drafts only, positive amounts only, nothing when blocked', () => {
    const d = computeStatement(source());
    const rows = distributionDrafts(d);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
    expect(distributionDrafts(computeStatement(source({ shares: [] })))).toHaveLength(0);
    expect(ownerShareAmount(d, 'o1')).toBe(492000);
    expect(ownerShareAmount(d, 'nobody')).toBe(0);
  });
});
