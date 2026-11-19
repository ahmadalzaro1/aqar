import type { Allocation } from '@aqar/contracts';
import { chequeBounceReversal, chequeTransition } from './cheque.js';

function allocation(paymentId: string, chargeId: string, amountFils: number): Allocation {
  return { paymentId, chargeId, amountFils };
}

describe('chequeTransition', () => {
  it('walks the lifecycle received -> deposited -> cleared', () => {
    const deposited = chequeTransition('received', 'deposit');
    expect(deposited).toBe('deposited');
    expect(chequeTransition(deposited, 'clear')).toBe('cleared');
  });

  it('bounces only from deposited', () => {
    expect(chequeTransition('deposited', 'bounce')).toBe('bounced');
  });

  it('throws for skipped or impossible transitions', () => {
    expect(() => chequeTransition('received', 'clear')).toThrow(RangeError);
    expect(() => chequeTransition('received', 'bounce')).toThrow(RangeError);
    expect(() => chequeTransition('cleared', 'bounce')).toThrow(RangeError);
    expect(() => chequeTransition('cleared', 'clear')).toThrow(RangeError);
    expect(() => chequeTransition('bounced', 'deposit')).toThrow(RangeError);
    expect(() => chequeTransition('bounced', 'clear')).toThrow(RangeError);
    expect(() => chequeTransition('deposited', 'deposit')).toThrow(RangeError);
  });
});

describe('chequeBounceReversal', () => {
  it('lists chargeId + amount entries to re-open', () => {
    expect(
      chequeBounceReversal([
        allocation('pay-1', 'charge-a', 100_000),
        allocation('pay-1', 'charge-b', 50_000),
      ]),
    ).toEqual([
      { chargeId: 'charge-a', amountFils: 100_000 },
      { chargeId: 'charge-b', amountFils: 50_000 },
    ]);
  });

  it('aggregates several allocations against one charge, in first-appearance order', () => {
    expect(
      chequeBounceReversal([
        allocation('pay-1', 'charge-b', 30_000),
        allocation('pay-1', 'charge-a', 20_000),
        allocation('pay-1', 'charge-b', 70_000),
      ]),
    ).toEqual([
      { chargeId: 'charge-b', amountFils: 100_000 },
      { chargeId: 'charge-a', amountFils: 20_000 },
    ]);
  });

  it('returns an empty plan when nothing was allocated', () => {
    expect(chequeBounceReversal([])).toEqual([]);
  });

  it('rejects non-positive allocation amounts', () => {
    expect(() => chequeBounceReversal([allocation('pay-1', 'charge-a', 0)])).toThrow(RangeError);
    expect(() => chequeBounceReversal([allocation('pay-1', 'charge-a', -5)])).toThrow(RangeError);
  });
});
