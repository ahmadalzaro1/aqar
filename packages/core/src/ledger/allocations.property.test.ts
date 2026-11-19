import * as fc from 'fast-check';
import type { Allocation, Charge, IsoDate, Period } from '@aqar/contracts';
import { allocatePayment, deriveChargeStatus, fromDayNumber, toDayNumber } from './index.js';
import { makeAllocation, makeCharge, makePayment } from './factories.test-helpers.js';

interface ChargeSpec {
  amountFils: number;
  paidFils: number;
  dueOffset: number;
}

interface ScenarioSpec {
  charges: ChargeSpec[];
  paymentFils: number;
  referencePeriod: Period | null;
}

const chargeSpecArb: fc.Arbitrary<ChargeSpec> = fc.record({
  amountFils: fc.integer({ min: 0, max: 1_000_000 }),
  paidFils: fc.integer({ min: 0, max: 1_000_000 }),
  dueOffset: fc.integer({ min: 0, max: 200 }),
});

const scenarioArb: fc.Arbitrary<ScenarioSpec> = fc.record({
  charges: fc.array(chargeSpecArb, { maxLength: 6 }),
  paymentFils: fc.integer({ min: 0, max: 5_000_000 }),
  referencePeriod: fc.oneof(
    fc.constant<Period | null>(null),
    fc.constantFrom<Period>('2026-03', '2026-04', '2026-05'),
  ),
});

const PERIODS: readonly Period[] = ['2026-03', '2026-04', '2026-05'];
const BASE_DAY = toDayNumber('2026-03-01' as IsoDate);

interface Scenario {
  charges: Charge[];
  existing: Allocation[];
  payment: ReturnType<typeof makePayment>;
  outstandingById: Map<string, number>;
  totalOutstanding: number;
}

function buildScenario(spec: ScenarioSpec): Scenario {
  const charges: Charge[] = [];
  const existing: Allocation[] = [];
  const outstandingById = new Map<string, number>();
  let totalOutstanding = 0;

  spec.charges.forEach((chargeSpec, index) => {
    const id = `c${index}`;
    const charge = makeCharge({
      id,
      period: PERIODS[index % PERIODS.length] ?? '2026-03',
      amountFils: chargeSpec.amountFils,
      dueDateISO: fromDayNumber(BASE_DAY + chargeSpec.dueOffset),
    });
    charges.push(charge);
    const paid = Math.min(chargeSpec.paidFils, chargeSpec.amountFils);
    if (paid > 0) existing.push(makeAllocation('prior', id, paid));
    const outstanding = Math.max(0, chargeSpec.amountFils - paid);
    outstandingById.set(id, outstanding);
    totalOutstanding += outstanding;
  });

  return {
    charges,
    existing,
    payment: makePayment({ amountFils: spec.paymentFils, referencePeriod: spec.referencePeriod }),
    outstandingById,
    totalOutstanding,
  };
}

describe('allocatePayment properties', () => {
  it('allocates exactly min(payment, total outstanding)', () => {
    fc.assert(
      fc.property(scenarioArb, (spec) => {
        const { charges, existing, payment, totalOutstanding } = buildScenario(spec);
        const allocations = allocatePayment(payment, charges, existing);
        const allocated = allocations.reduce((sum, allocation) => sum + allocation.amountFils, 0);
        expect(allocated).toBe(Math.min(payment.amountFils, totalOutstanding));
      }),
    );
  });

  it('never overallocates a charge, never duplicates one, never emits non-positives', () => {
    fc.assert(
      fc.property(scenarioArb, (spec) => {
        const { charges, existing, payment, outstandingById } = buildScenario(spec);
        const allocations = allocatePayment(payment, charges, existing);
        const seen = new Set<string>();
        for (const allocation of allocations) {
          expect(allocation.paymentId).toBe(payment.id);
          expect(Number.isInteger(allocation.amountFils)).toBe(true);
          expect(allocation.amountFils).toBeGreaterThan(0);
          expect(seen.has(allocation.chargeId)).toBe(false);
          seen.add(allocation.chargeId);
          expect(allocation.amountFils).toBeLessThanOrEqual(outstandingById.get(allocation.chargeId) ?? 0);
        }
      }),
    );
  });

  it('walks oldest due date first when no reference period is trusted', () => {
    fc.assert(
      fc.property(scenarioArb, (spec) => {
        const { charges, existing, payment } = buildScenario(spec);
        const trusted = makePayment({ amountFils: payment.amountFils, referencePeriod: null });
        const allocations = allocatePayment(trusted, charges, existing);
        const dueById = new Map(charges.map((charge) => [charge.id, charge.dueDateISO]));
        const dues = allocations.map((allocation) => dueById.get(allocation.chargeId) ?? '');
        const sorted = [...dues].sort();
        expect(dues).toEqual(sorted);
      }),
    );
  });

  it('is idempotent when its own output is fed back in', () => {
    fc.assert(
      fc.property(scenarioArb, (spec) => {
        const { charges, existing, payment } = buildScenario(spec);
        const first = allocatePayment(payment, charges, existing);
        expect(allocatePayment(payment, charges, [...existing, ...first])).toEqual([]);
      }),
    );
  });

  it('leaves every charge paid or resting in a legal derived status', () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer({ min: 0, max: 400 }), (spec, asOfOffset) => {
        const { charges, existing, payment } = buildScenario(spec);
        const allocations = [...existing, ...allocatePayment(payment, charges, existing)];
        const asOfISO = fromDayNumber(BASE_DAY + asOfOffset);
        for (const charge of charges) {
          const status = deriveChargeStatus(charge, allocations, asOfISO);
          expect(['open', 'partial', 'paid', 'overdue']).toContain(status);
          const allocated = allocations
            .filter((allocation) => allocation.chargeId === charge.id)
            .reduce((sum, allocation) => sum + allocation.amountFils, 0);
          if (status === 'paid') expect(allocated).toBeGreaterThanOrEqual(charge.amountFils);
          if (status === 'overdue') expect(allocated).toBeLessThan(charge.amountFils);
          if (status === 'partial') expect(allocated).toBeGreaterThan(0);
          if (status === 'open') expect(allocated).toBe(0);
        }
      }),
    );
  });
});
