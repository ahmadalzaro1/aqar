import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { vendorScore } from './vendor.js';
import { occupancyRate, collectionRateBps, delinquencyRateBps } from './metrics.js';

const arbStats = fc.record({
  jobsTotal: fc.integer({ min: 0, max: 1000 }),
  jobsCompleted: fc.integer({ min: 0, max: 1000 }),
  jobsOnTime: fc.integer({ min: 0, max: 1000 }),
  costVarianceBpsSum: fc.integer({ min: -1_000_000, max: 1_000_000 }),
  jobsReworked: fc.integer({ min: 0, max: 1000 }),
});

describe('vendorScore properties', () => {
  it('always returns an integer in [0,100] or null', () => {
    fc.assert(fc.property(arbStats, (stats) => {
      const score = vendorScore(stats);
      if (score === null) expect(stats.jobsTotal).toBe(0);
      else {
        expect(Number.isInteger(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    }), { numRuns: 1000 });
  });

  it('zero jobs is always null', () => {
    fc.assert(fc.property(arbStats, (stats) => {
      expect(vendorScore({ ...stats, jobsTotal: 0 })).toBeNull();
    }), { numRuns: 200 });
  });

  it('a perfect vendor always scores 100', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
      expect(vendorScore({ jobsTotal: n, jobsCompleted: n, jobsOnTime: n, costVarianceBpsSum: 0, jobsReworked: 0 })).toBe(100);
    }), { numRuns: 200 });
  });

  it('is deterministic', () => {
    fc.assert(fc.property(arbStats, (stats) => {
      expect(vendorScore(stats)).toBe(vendorScore(stats));
    }), { numRuns: 300 });
  });
});

describe('metric properties', () => {
  const arbUnits = fc.array(fc.constantFrom('occupied' as const, 'vacant' as const, 'turnover' as const, 'unavailable' as const), { maxLength: 200 });

  it('occupancy is always an integer bps in [0,10000]', () => {
    fc.assert(fc.property(arbUnits, (statuses) => {
      const rate = occupancyRate(statuses.map((status) => ({ status })));
      expect(Number.isInteger(rate)).toBe(true);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(10000);
    }), { numRuns: 500 });
  });

  it('collection rate never exceeds 100% and never goes negative', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.integer({ min: 0, max: 10_000_000 }),
      (collected, billed) => {
        const rate = collectionRateBps(collected, billed);
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(10000);
        expect(Number.isInteger(rate)).toBe(true);
      },
    ), { numRuns: 500 });
  });

  it('zero billed always yields 0 delinquency (no NaN, no Infinity)', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000 }), (outstanding) => {
      expect(delinquencyRateBps(outstanding, 0)).toBe(0);
    }), { numRuns: 200 });
  });
});
