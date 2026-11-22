import type { OwnerShare } from '@aqar/contracts';
import fc from 'fast-check';
import { splitByShares } from './shares.js';

/** Random partition of 10000 bps across 1..6 owners (sums to exactly 10000). */
const shareSetArb: fc.Arbitrary<OwnerShare[]> = fc
  .array(fc.integer({ min: 0, max: 10000 }), { minLength: 0, maxLength: 5 })
  .map((cuts) => {
    const sorted = [...cuts].sort((a, b) => a - b);
    const bounds = [0, ...sorted, 10000];
    const shares: OwnerShare[] = [];
    for (let index = 1; index < bounds.length; index += 1) {
      const lower = bounds[index - 1] ?? 0;
      const upper = bounds[index] ?? 10000;
      shares.push({
        ownerId: `owner-${String(index - 1).padStart(2, '0')}`,
        shareBps: upper - lower,
      });
    }
    return shares;
  });

const fourEqualHeirs: OwnerShare[] = [
  { ownerId: 'heir-1', shareBps: 2500 },
  { ownerId: 'heir-2', shareBps: 2500 },
  { ownerId: 'heir-3', shareBps: 2500 },
  { ownerId: 'heir-4', shareBps: 2500 },
];

const totalArb = fc.oneof(
  fc.nat({ max: 1_000_000_000 }),
  fc.constantFrom(0, 1, 3, 999, 1000, 1001, 100_000, 1_000_001),
);

describe('splitByShares (properties)', () => {
  it('always distributes every fil: no lost or invented fils', () => {
    fc.assert(
      fc.property(totalArb, shareSetArb, (total, shares) => {
        const result = splitByShares(total, shares);
        expect(Object.keys(result)).toHaveLength(shares.length);
        let sum = 0;
        for (const share of shares) {
          const amount = result[share.ownerId];
          expect(amount).toBeDefined();
          expect(Number.isInteger(amount)).toBe(true);
          expect(amount ?? -1).toBeGreaterThanOrEqual(0);
          sum += amount ?? 0;
        }
        expect(sum).toBe(total);
      }),
      { numRuns: 1500 },
    );
  });

  it('never gives an owner more than one fil above their floored share', () => {
    fc.assert(
      fc.property(totalArb, shareSetArb, (total, shares) => {
        const result = splitByShares(total, shares);
        for (const share of shares) {
          const floored = Number((BigInt(total) * BigInt(share.shareBps)) / 10000n);
          const amount = result[share.ownerId] ?? -1;
          expect(amount).toBeGreaterThanOrEqual(floored);
          expect(amount).toBeLessThanOrEqual(floored + 1);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('handles four equal heirs on any total', () => {
    fc.assert(
      fc.property(totalArb, (total) => {
        const result = splitByShares(total, fourEqualHeirs);
        const values = fourEqualHeirs.map((share) => result[share.ownerId] ?? -1);
        expect(values.reduce((sum, value) => sum + value, 0)).toBe(total);
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 1500 },
    );
  });

  it('rejects any share set that is off by one basis point', () => {
    fc.assert(
      fc.property(totalArb, shareSetArb, (total, shares) => {
        const first = shares[0];
        if (first === undefined) {
          return;
        }
        const broken = [{ ...first, shareBps: first.shareBps + 1 }, ...shares.slice(1)];
        expect(() => splitByShares(total, broken)).toThrow(RangeError);
      }),
      { numRuns: 500 },
    );
  });
});
