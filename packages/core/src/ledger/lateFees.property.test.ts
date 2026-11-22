import * as fc from 'fast-check';
import type { IsoDate, LateFeeRule } from '@aqar/contracts';
import { computeLateFee, daysBetween, fromDayNumber, toDayNumber } from './index.js';
import { makeCharge } from './factories.test-helpers.js';

const BASE_DAY = toDayNumber('2026-03-01' as IsoDate);

const ruleArb: fc.Arbitrary<LateFeeRule> = fc.oneof(
  fc.record({
    kind: fc.constant<'flat'>('flat'),
    amountFils: fc.integer({ min: 0, max: 1_000_000 }),
    graceDays: fc.integer({ min: 0, max: 15 }),
    capFils: fc.oneof(fc.constant<number | null>(null), fc.integer({ min: 0, max: 500_000 })),
  }),
  fc.record({
    kind: fc.constant<'percent'>('percent'),
    basisPoints: fc.integer({ min: 0, max: 10000 }),
    graceDays: fc.integer({ min: 0, max: 15 }),
    capFils: fc.oneof(fc.constant<number | null>(null), fc.integer({ min: 0, max: 500_000 })),
  }),
);

describe('computeLateFee properties', () => {
  it('is zero inside the grace window and a safe integer outside it', () => {
    fc.assert(
      fc.property(
        ruleArb,
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 400 }),
        (rule, dueOffset, outstandingFils, asOfOffset) => {
          const charge = makeCharge({
            id: 'c1',
            amountFils: 1_000_000,
            dueDateISO: fromDayNumber(BASE_DAY + dueOffset),
          });
          const asOfISO = fromDayNumber(BASE_DAY + dueOffset + asOfOffset);
          const fee = computeLateFee(rule, charge, outstandingFils, asOfISO);
          expect(Number.isInteger(fee)).toBe(true);
          expect(fee).toBeGreaterThanOrEqual(0);
          const daysLate = daysBetween(charge.dueDateISO, asOfISO);
          if (daysLate <= rule.graceDays) expect(fee).toBe(0);
        },
      ),
    );
  });

  it('never exceeds the cap, the flat amount or the outstanding balance', () => {
    fc.assert(
      fc.property(ruleArb, fc.integer({ min: 0, max: 1_000_000 }), (rule, outstandingFils) => {
        const charge = makeCharge({ id: 'c1', amountFils: 1_000_000, dueDateISO: '2026-03-05' });
        const fee = computeLateFee(rule, charge, outstandingFils, '2026-12-31');
        if (rule.capFils !== null) expect(fee).toBeLessThanOrEqual(rule.capFils);
        if (rule.kind === 'flat') {
          const expected = Math.min(rule.capFils ?? rule.amountFils, rule.amountFils);
          expect(fee).toBe(outstandingFils === 0 ? 0 : expected);
        } else {
          const raw = Math.floor((outstandingFils * rule.basisPoints) / 10000);
          const expected = Math.min(raw, rule.capFils ?? raw);
          expect(fee).toBe(expected);
          expect(fee).toBeLessThanOrEqual(outstandingFils);
        }
        if (outstandingFils === 0) expect(fee).toBe(0);
      }),
    );
  });

  it('never depends on the original charge amount once outstanding is known', () => {
    fc.assert(
      fc.property(
        ruleArb,
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (rule, outstandingFils, extraChargeFils) => {
          const small = makeCharge({
            id: 'c1',
            amountFils: outstandingFils,
            dueDateISO: '2026-03-05',
          });
          const large = makeCharge({
            id: 'c1',
            amountFils: outstandingFils + extraChargeFils,
            dueDateISO: '2026-03-05',
          });
          const asOfISO = '2026-09-30' as IsoDate;
          expect(computeLateFee(rule, large, outstandingFils, asOfISO)).toBe(
            computeLateFee(rule, small, outstandingFils, asOfISO),
          );
        },
      ),
    );
  });
});
