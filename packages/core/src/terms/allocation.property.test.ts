import type { SharedAllocationMode } from '@aqar/contracts';
import fc from 'fast-check';
import { allocateSharedService } from './shares.js';

const modeArb: fc.Arbitrary<SharedAllocationMode> = fc.constantFrom<SharedAllocationMode>(
  'per_unit',
  'by_area',
  'by_headcount',
  'by_ampere',
  'flat',
);

const weightsArb = fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 1, maxLength: 8 });
const totalArb = fc.oneof(
  fc.nat({ max: 5_000_000 }),
  fc.constantFrom(0, 1, 7, 999, 1000, 100_000, 1_000_001),
);

function isEqualMode(mode: SharedAllocationMode): boolean {
  return mode === 'per_unit' || mode === 'flat';
}

describe('allocateSharedService (properties)', () => {
  it('always assigns every fil of the shared invoice', () => {
    fc.assert(
      fc.property(totalArb, weightsArb, modeArb, (total, weights, mode) => {
        const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
        fc.pre(isEqualMode(mode) || weightSum > 0);
        const result = allocateSharedService(total, weights, mode);
        expect(result).toHaveLength(weights.length);
        let sum = 0;
        for (const amount of result) {
          expect(Number.isInteger(amount)).toBe(true);
          expect(amount).toBeGreaterThanOrEqual(0);
          sum += amount;
        }
        expect(sum).toBe(total);
      }),
      { numRuns: 1500 },
    );
  });

  it('splits equal modes within one fil of each other', () => {
    fc.assert(
      fc.property(totalArb, fc.integer({ min: 1, max: 8 }), (total, unitCount) => {
        const weights = Array.from({ length: unitCount }, () => 0);
        const result = allocateSharedService(total, weights, 'per_unit');
        expect(Math.max(...result) - Math.min(...result)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 1500 },
    );
  });

  it('allocates proportional modes no more than one fil off the exact ratio', () => {
    fc.assert(
      fc.property(
        totalArb,
        fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 8 }),
        fc.constantFrom<SharedAllocationMode>('by_area', 'by_headcount', 'by_ampere'),
        (total, weights, mode) => {
          const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
          const result = allocateSharedService(total, weights, mode);
          for (let index = 0; index < weights.length; index += 1) {
            const weight = weights[index] ?? 0;
            const floored = Number((BigInt(total) * BigInt(weight)) / BigInt(weightSum));
            const amount = result[index] ?? -1;
            expect(amount).toBeGreaterThanOrEqual(floored);
            expect(amount).toBeLessThanOrEqual(floored + 1);
          }
        },
      ),
      { numRuns: 1500 },
    );
  });
});
