import type { EscalationRule } from '@aqar/contracts';
import fc from 'fast-check';
import { escalationSchedule } from './escalation.js';

const ruleArb: fc.Arbitrary<EscalationRule> = fc.oneof(
  fc.constant<EscalationRule>({ kind: 'none' }),
  fc
    .record({
      basisPoints: fc.integer({ min: 0, max: 10000 }),
      everyMonths: fc.integer({ min: 1, max: 36 }),
    })
    .map<EscalationRule>((parts) => ({ kind: 'percent', ...parts })),
  fc
    .record({
      amountFils: fc.integer({ min: 0, max: 1_000_000 }),
      everyMonths: fc.integer({ min: 1, max: 36 }),
    })
    .map<EscalationRule>((parts) => ({ kind: 'flat', ...parts })),
);

describe('escalationSchedule (properties)', () => {
  it('is nondecreasing and never drops below the base rent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        ruleArb,
        fc.integer({ min: 0, max: 240 }),
        (baseRentFils, rule, months) => {
          const schedule = escalationSchedule(baseRentFils, rule, months);
          expect(schedule).toHaveLength(months);
          let previous = baseRentFils;
          for (const rent of schedule) {
            expect(Number.isInteger(rent)).toBe(true);
            expect(rent).toBeGreaterThanOrEqual(previous);
            expect(rent).toBeGreaterThanOrEqual(baseRentFils);
            previous = rent;
          }
        },
      ),
      { numRuns: 1200 },
    );
  });

  it('raises the rent exactly once per completed interval (non-compounding)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 10000 }),
        fc.integer({ min: 1, max: 36 }),
        (baseRentFils, basisPoints, everyMonths) => {
          const step = Number((BigInt(baseRentFils) * BigInt(basisPoints)) / 10000n);
          const schedule = escalationSchedule(
            baseRentFils,
            { kind: 'percent', basisPoints, everyMonths },
            everyMonths * 3,
          );
          for (let index = 0; index < schedule.length; index += 1) {
            const intervals = Math.floor(index / everyMonths);
            expect(schedule[index]).toBe(baseRentFils + step * intervals);
          }
        },
      ),
      { numRuns: 1200 },
    );
  });
});
