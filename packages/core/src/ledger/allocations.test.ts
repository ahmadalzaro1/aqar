import { allocatePayment, deriveChargeStatus, outstandingFils } from './index.js';
import { makeAllocation, makeCharge, makePayment } from './factories.test-helpers.js';

const april = makeCharge({
  id: 'c-apr',
  period: '2026-04',
  amountFils: 200000,
  dueDateISO: '2026-04-05',
});
const may = makeCharge({
  id: 'c-may',
  period: '2026-05',
  amountFils: 200000,
  dueDateISO: '2026-05-05',
});

describe('outstandingFils', () => {
  it('subtracts allocations and floors at zero', () => {
    expect(outstandingFils(april, [])).toBe(200000);
    expect(outstandingFils(april, [makeAllocation('p0', 'c-apr', 125000)])).toBe(75000);
    expect(outstandingFils(april, [makeAllocation('p0', 'c-apr', 250000)])).toBe(0);
  });

  it('ignores allocations for other charges', () => {
    expect(outstandingFils(april, [makeAllocation('p0', 'c-may', 50000)])).toBe(200000);
  });
});

describe('allocatePayment', () => {
  it('applies a partial payment to the only open charge', () => {
    const allocations = allocatePayment(makePayment({ amountFils: 150000 }), [april], []);
    expect(allocations).toEqual([{ paymentId: 'pay-1', chargeId: 'c-apr', amountFils: 150000 }]);
  });

  it('cascades oldest due date first when no reference period is trusted', () => {
    const allocations = allocatePayment(makePayment({ amountFils: 250000 }), [may, april], []);
    expect(allocations).toEqual([
      { paymentId: 'pay-1', chargeId: 'c-apr', amountFils: 200000 },
      { paymentId: 'pay-1', chargeId: 'c-may', amountFils: 50000 },
    ]);
  });

  it('honours a trusted reference period before older debt', () => {
    const payment = makePayment({ amountFils: 250000, referencePeriod: '2026-05' });
    const allocations = allocatePayment(payment, [april, may], []);
    expect(allocations).toEqual([
      { paymentId: 'pay-1', chargeId: 'c-may', amountFils: 200000 },
      { paymentId: 'pay-1', chargeId: 'c-apr', amountFils: 50000 },
    ]);
  });

  it('orders charges inside the reference period by due date then id', () => {
    const late = makeCharge({
      id: 'b-second',
      period: '2026-05',
      dueDateISO: '2026-05-20',
      amountFils: 10000,
    });
    const first = makeCharge({
      id: 'a-first',
      period: '2026-05',
      dueDateISO: '2026-05-05',
      amountFils: 10000,
    });
    const tie = makeCharge({
      id: 'a-tie',
      period: '2026-05',
      dueDateISO: '2026-05-05',
      amountFils: 10000,
    });
    const payment = makePayment({ amountFils: 25000, referencePeriod: '2026-05' });
    const allocations = allocatePayment(payment, [late, tie, first], []);
    expect(allocations.map((a) => a.chargeId)).toEqual(['a-first', 'a-tie', 'b-second']);
  });

  it('falls back to oldest-first when the reference period has no charges', () => {
    const payment = makePayment({ amountFils: 50000, referencePeriod: '2026-09' });
    const allocations = allocatePayment(payment, [april, may], []);
    expect(allocations).toEqual([{ paymentId: 'pay-1', chargeId: 'c-apr', amountFils: 50000 }]);
  });

  it('never overallocates and never invents money', () => {
    const allocations = allocatePayment(makePayment({ amountFils: 500000 }), [april, may], []);
    const total = allocations.reduce((sum, a) => sum + a.amountFils, 0);
    expect(total).toBe(400000);
    expect(allocations.every((a) => a.amountFils > 0)).toBe(true);
  });

  it('respects allocations already recorded against a charge', () => {
    const existing = [makeAllocation('earlier', 'c-apr', 150000)];
    const allocations = allocatePayment(
      makePayment({ amountFils: 100000 }),
      [april, may],
      existing,
    );
    expect(allocations).toEqual([
      { paymentId: 'pay-1', chargeId: 'c-apr', amountFils: 50000 },
      { paymentId: 'pay-1', chargeId: 'c-may', amountFils: 50000 },
    ]);
  });

  it('only spends the part of this payment that is still unallocated', () => {
    const existing = [makeAllocation('pay-1', 'c-apr', 200000)];
    const allocations = allocatePayment(
      makePayment({ amountFils: 250000 }),
      [april, may],
      existing,
    );
    expect(allocations).toEqual([{ paymentId: 'pay-1', chargeId: 'c-may', amountFils: 50000 }]);
  });

  it('skips fully settled charges', () => {
    const existing = [makeAllocation('earlier', 'c-apr', 200000)];
    const allocations = allocatePayment(
      makePayment({ amountFils: 100000 }),
      [april, may],
      existing,
    );
    expect(allocations).toEqual([{ paymentId: 'pay-1', chargeId: 'c-may', amountFils: 100000 }]);
  });

  it('is idempotent when its own output is fed back as existing allocations', () => {
    const payment = makePayment({ amountFils: 250000 });
    const first = allocatePayment(payment, [april, may], []);
    expect(allocatePayment(payment, [april, may], first)).toEqual([]);
  });

  it('returns nothing for a zero payment or an empty charge list', () => {
    expect(allocatePayment(makePayment({ amountFils: 0 }), [april], [])).toEqual([]);
    expect(allocatePayment(makePayment({ amountFils: 1000 }), [], [])).toEqual([]);
  });

  it('ignores untrusted reference text', () => {
    const payment = makePayment({
      amountFils: 1000,
      referenceText: 'for May rent',
      referencePeriod: null,
    });
    const allocations = allocatePayment(payment, [april, may], []);
    expect(allocations.map((a) => a.chargeId)).toEqual(['c-apr']);
  });
});

describe('deriveChargeStatus', () => {
  it('is paid once fully allocated, even past due', () => {
    const paid = [makeAllocation('p1', 'c-apr', 200000)];
    expect(deriveChargeStatus(april, paid, '2026-06-01')).toBe('paid');
  });

  it('is overdue past the due date when money is still owed', () => {
    expect(deriveChargeStatus(april, [], '2026-04-06')).toBe('overdue');
    expect(deriveChargeStatus(april, [makeAllocation('p1', 'c-apr', 1000)], '2026-05-01')).toBe(
      'overdue',
    );
  });

  it('is not overdue on the due date itself', () => {
    expect(deriveChargeStatus(april, [], '2026-04-05')).toBe('open');
  });

  it('is partial when some money arrived and the date has not passed', () => {
    expect(deriveChargeStatus(april, [makeAllocation('p1', 'c-apr', 1000)], '2026-04-01')).toBe(
      'partial',
    );
  });

  it('is open with no money and no lateness', () => {
    expect(deriveChargeStatus(april, [], '2026-03-01')).toBe('open');
  });

  it('is paid for a zero-fils charge', () => {
    const free = makeCharge({ id: 'free', amountFils: 0 });
    expect(deriveChargeStatus(free, [], '2026-04-01')).toBe('paid');
  });
});
