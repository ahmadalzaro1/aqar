import * as fc from 'fast-check';
import type { IsoDate, LeaseMoneyTerms, Period } from '@aqar/contracts';
import {
  daysInMonth,
  formatPeriod,
  fromDayNumber,
  generateMonthlyCharges,
  monthBounds,
  parsePeriod,
  toDayNumber,
} from './index.js';
import { makeLease } from './factories.test-helpers.js';

interface LeaseSpec {
  startOffset: number;
  lengthDays: number;
  rentFils: number;
  dueDay: number;
  status: LeaseMoneyTerms['status'];
}

interface ScenarioSpec {
  year: number;
  month: number;
  leases: LeaseSpec[];
}

const leaseSpecArb: fc.Arbitrary<LeaseSpec> = fc.record({
  startOffset: fc.integer({ min: -400, max: 120 }),
  lengthDays: fc.integer({ min: 1, max: 700 }),
  rentFils: fc.integer({ min: 0, max: 100_000_000 }),
  dueDay: fc.integer({ min: 1, max: 28 }),
  status: fc.constantFrom<LeaseMoneyTerms['status']>('upcoming', 'active', 'ended', 'cancelled'),
});

const scenarioArb: fc.Arbitrary<ScenarioSpec> = fc.record({
  year: fc.integer({ min: 2020, max: 2032 }),
  month: fc.integer({ min: 1, max: 12 }),
  leases: fc.array(leaseSpecArb, { maxLength: 6 }),
});

function buildScenario(spec: ScenarioSpec): { period: Period; leases: LeaseMoneyTerms[] } {
  const period = formatPeriod(spec.year, spec.month);
  const firstDay = toDayNumber(`${period}-01` as IsoDate);
  const leases = spec.leases.map((lease, index) => {
    const start = firstDay + lease.startOffset;
    return makeLease({
      leaseId: `lease-${index}`,
      rentFils: lease.rentFils,
      dueDay: lease.dueDay,
      startISO: fromDayNumber(start),
      endISO: fromDayNumber(start + lease.lengthDays - 1),
      status: lease.status,
    });
  });
  return { period, leases };
}

function permute<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, index) => ({ item, key: keys[index] ?? 0, index }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((entry) => entry.item);
}

describe('generateMonthlyCharges properties', () => {
  it('is idempotent under repetition', () => {
    fc.assert(
      fc.property(scenarioArb, (spec) => {
        const { period, leases } = buildScenario(spec);
        const first = generateMonthlyCharges(leases, period, []);
        expect(generateMonthlyCharges(leases, period, first)).toEqual([]);
        expect(generateMonthlyCharges(leases, period, [...first, ...first])).toEqual([]);
        expect(generateMonthlyCharges(leases, period, first)).toEqual([]);
      }),
    );
  });

  it('is invariant under lease input reordering', () => {
    fc.assert(
      fc.property(scenarioArb, fc.array(fc.integer(), { minLength: 6, maxLength: 6 }), (spec, keys) => {
        const { period, leases } = buildScenario(spec);
        const forward = generateMonthlyCharges(leases, period, []);
        const shuffled = generateMonthlyCharges(permute(leases, keys), period, []);
        const reversed = generateMonthlyCharges([...leases].reverse(), period, []);
        expect(shuffled).toEqual(forward);
        expect(reversed).toEqual(forward);
      }),
    );
  });

  it('emits at most one rent charge per lease with contract-shaped, integer money', () => {
    fc.assert(
      fc.property(scenarioArb, (spec) => {
        const { period, leases } = buildScenario(spec);
        const charges = generateMonthlyCharges(leases, period, []);
        const byLeaseId = new Map(leases.map((lease) => [lease.leaseId, lease]));
        const seen = new Set<string>();
        const { year, month } = parsePeriod(period);
        const dim = daysInMonth(year, month);
        const bounds = monthBounds(period);

        for (const charge of charges) {
          expect(charge.id).toBe(`${charge.leaseId}:${period}:rent`);
          expect(charge.kind).toBe('rent');
          expect(charge.period).toBe(period);
          expect(Number.isInteger(charge.amountFils)).toBe(true);
          expect(charge.amountFils).toBeGreaterThanOrEqual(0);
          expect(charge.dueDateISO.startsWith(`${period}-`)).toBe(true);
          expect(seen.has(charge.leaseId)).toBe(false);
          seen.add(charge.leaseId);

          const lease = byLeaseId.get(charge.leaseId);
          expect(lease).toBeDefined();
          if (lease === undefined) continue;

          expect(charge.amountFils).toBeLessThanOrEqual(lease.rentFils);
          if (charge.proratedDays === null) {
            expect(charge.amountFils).toBe(lease.rentFils);
          } else {
            const days = charge.proratedDays;
            expect(days).toBeGreaterThan(0);
            expect(days).toBeLessThan(dim);
            expect(charge.amountFils).toBe(Math.floor((lease.rentFils * days) / dim));
            // the prorated day count matches the clipped term length
            const clippedStart = Math.max(toDayNumber(lease.startISO), bounds.firstDay);
            const clippedEnd = Math.min(toDayNumber(lease.endISO), bounds.lastDay);
            expect(days).toBe(clippedEnd - clippedStart + 1);
          }
        }

        // every intersecting active/upcoming lease that is not yet charged must appear
        for (const lease of leases) {
          if (lease.status !== 'active' && lease.status !== 'upcoming') continue;
          const intersects =
            toDayNumber(lease.endISO) >= bounds.firstDay && toDayNumber(lease.startISO) <= bounds.lastDay;
          expect(seen.has(lease.leaseId)).toBe(intersects);
        }
      }),
    );
  });

  it('is stable when existing charges already cover the period', () => {
    fc.assert(
      fc.property(scenarioArb, (spec) => {
        const { period, leases } = buildScenario(spec);
        const generated = generateMonthlyCharges(leases, period, []);
        const union = [...generated, ...generated.map((charge) => ({ ...charge, id: `legacy-${charge.id}` }))];
        expect(generateMonthlyCharges(leases, period, union)).toEqual([]);
      }),
    );
  });
});
