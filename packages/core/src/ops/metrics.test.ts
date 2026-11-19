import { describe, expect, it } from 'vitest';
import {
  occupancyRate,
  delinquencyRateBps,
  collectionRateBps,
  noiFils,
  workOrderAging,
  meanTimeToResolutionHours,
} from './metrics.js';

describe('occupancyRate (frozen contracts enum)', () => {
  it('counts occupied over leasable stock in basis points', () => {
    expect(occupancyRate([{ status: 'occupied' }, { status: 'occupied' }, { status: 'vacant' }, { status: 'turnover' }])).toBe(5000);
  });
  it('excludes unavailable units from the denominator', () => {
    expect(occupancyRate([{ status: 'occupied' }, { status: 'unavailable' }])).toBe(10000);
  });
  it('empty portfolio is 0, not NaN', () => {
    expect(occupancyRate([])).toBe(0);
    expect(occupancyRate([{ status: 'unavailable' }])).toBe(0);
  });
});

describe('delinquency / collection / NOI', () => {
  it('delinquency is outstanding over billed, in bps', () => {
    expect(delinquencyRateBps(250_000, 1_000_000)).toBe(2500);
    expect(delinquencyRateBps(0, 0)).toBe(0);
  });
  it('collection clamps to 100% on over-collection', () => {
    expect(collectionRateBps(1_200_000, 1_000_000)).toBe(10000);
    expect(collectionRateBps(900_000, 1_000_000)).toBe(9000);
    expect(collectionRateBps(0, 0)).toBe(0);
  });
  it('NOI can be negative (a loss-making property is reported honestly)', () => {
    expect(noiFils(500_000, 300_000)).toBe(200_000);
    expect(noiFils(100_000, 300_000)).toBe(-200_000);
  });
});

describe('workOrderAging', () => {
  const NOW = '2026-03-31T00:00:00.000Z';
  it('buckets open tickets by age and ignores closed ones', () => {
    const report = workOrderAging(
      [
        { openedAtISO: '2026-03-30T00:00:00.000Z', status: 'open' },        // 1 day
        { openedAtISO: '2026-03-20T00:00:00.000Z', status: 'in_progress' }, // 11 days
        { openedAtISO: '2026-02-20T00:00:00.000Z', status: 'open' },        // 39 days
        { openedAtISO: '2025-12-01T00:00:00.000Z', status: 'open' },        // 120 days
        { openedAtISO: '2025-01-01T00:00:00.000Z', status: 'closed' },
      ],
      NOW,
    );
    expect(report.d0_7).toBe(1);
    expect(report.d8_30).toBe(1);
    expect(report.d31_90).toBe(1);
    expect(report.d90_plus).toBe(1);
    expect(report.totalOpen).toBe(4);
  });
  it('empty input yields all-zero buckets', () => {
    const report = workOrderAging([], NOW);
    expect(report.d0_7 + report.d8_30 + report.d31_90 + report.d90_plus).toBe(0);
    expect(report.totalOpen).toBe(0);
  });
});

describe('meanTimeToResolutionHours', () => {
  it('averages closed-ticket resolution times', () => {
    expect(
      meanTimeToResolutionHours([
        { openedAtISO: '2026-03-01T00:00:00.000Z', closedAtISO: '2026-03-02T00:00:00.000Z' },
        { openedAtISO: '2026-03-01T00:00:00.000Z', closedAtISO: '2026-03-03T00:00:00.000Z' },
      ]),
    ).toBe(36);
  });
  it('no resolved tickets returns null, never 0', () => {
    expect(meanTimeToResolutionHours([])).toBeNull();
  });
});
