import * as fc from 'fast-check';
import type { IsoDate } from '@aqar/contracts';
import { AGING_BUCKETS, agingBucketFor, agingReport, fromDayNumber, toDayNumber } from './index.js';
import { makeAllocation, makeCharge } from './factories.test-helpers.js';

const BASE_DAY = toDayNumber('2026-01-01' as IsoDate);
const BASE_ISO = '2026-01-01' as IsoDate;

describe('aging properties', () => {
  it('is monotonic in asOf: a balance only moves to an equal or older bucket', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -200, max: 200 }),
        fc.integer({ min: -100, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (dueOffset, asOfOffset, advance) => {
          const charge = makeCharge({
            id: 'c1',
            dueDateISO: fromDayNumber(BASE_DAY + dueOffset),
            amountFils: 100000,
          });
          const early = agingReport([charge], [], fromDayNumber(BASE_DAY + asOfOffset));
          const late = agingReport([charge], [], fromDayNumber(BASE_DAY + asOfOffset + advance));
          const earlyBucket = early.rows[0]?.bucket ?? 'current';
          const lateBucket = late.rows[0]?.bucket ?? 'current';
          expect(AGING_BUCKETS.indexOf(lateBucket)).toBeGreaterThanOrEqual(AGING_BUCKETS.indexOf(earlyBucket));
        },
      ),
    );
  });

  it('buckets match days past due and never change the balance', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amountFils: fc.integer({ min: 0, max: 1_000_000 }),
            paidFils: fc.integer({ min: 0, max: 1_000_000 }),
            dueOffset: fc.integer({ min: -300, max: 300 }),
          }),
          { maxLength: 8 },
        ),
        fc.integer({ min: -200, max: 400 }),
        (specs, asOfOffset) => {
          const charges = specs.map((spec, index) =>
            makeCharge({
              id: `c${index}`,
              amountFils: spec.amountFils,
              dueDateISO: fromDayNumber(BASE_DAY + spec.dueOffset),
            }),
          );
          const allocations = specs
            .map((spec, index) => makeAllocation('prior', `c${index}`, Math.min(spec.paidFils, spec.amountFils)))
            .filter((allocation) => allocation.amountFils > 0);
          const asOfISO = fromDayNumber(BASE_DAY + asOfOffset);
          const report = agingReport(charges, allocations, asOfISO);

          const expectedBalance = new Map<string, number>();
          specs.forEach((spec, index) => {
            const paid = Math.min(spec.paidFils, spec.amountFils);
            const balance = Math.max(0, spec.amountFils - paid);
            if (balance > 0) expectedBalance.set(`c${index}`, balance);
          });

          expect(report.rows).toHaveLength(expectedBalance.size);
          let rowTotal = 0;
          for (const row of report.rows) {
            expect(row.balanceFils).toBe(expectedBalance.get(row.chargeId));
            expect(row.balanceFils).toBeGreaterThan(0);
            expect(Number.isInteger(row.balanceFils)).toBe(true);
            expect(row.bucket).toBe(agingBucketFor(toDayNumber(asOfISO) - toDayNumber(row.dueDateISO)));
            rowTotal += row.balanceFils;
          }

          const bucketTotal = AGING_BUCKETS.reduce((sum, bucket) => sum + report.buckets[bucket], 0);
          expect(bucketTotal).toBe(rowTotal);
          expect(report.totalFils).toBe(rowTotal);
          for (const bucket of AGING_BUCKETS) {
            const bucketRows = report.rows
              .filter((row) => row.bucket === bucket)
              .reduce((sum, row) => sum + row.balanceFils, 0);
            expect(report.buckets[bucket]).toBe(bucketRows);
          }

          // the same balances aged later keep the same total, only the buckets shift
          const later = agingReport(charges, allocations, fromDayNumber(BASE_DAY + asOfOffset + 365));
          expect(later.totalFils).toBe(report.totalFils);
        },
      ),
    );
  });

  it('keeps rows in due-date order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 8 }),
        (offsets) => {
          const charges = offsets.map((offset, index) =>
            makeCharge({ id: `c${index}`, dueDateISO: fromDayNumber(BASE_DAY + offset) }),
          );
          const report = agingReport(charges, [], BASE_ISO);
          const dues = report.rows.map((row) => row.dueDateISO);
          expect(dues).toEqual([...dues].sort());
        },
      ),
    );
  });
});
