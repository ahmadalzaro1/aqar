import { describe, expect, it } from 'vitest';
import { validateActionArgs } from './args.js';

const payment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  leaseId: 'lease-1',
  amountFils: 125_000,
  method: 'cash',
  receivedDate: '2026-11-21',
  reference: 'R-1',
  note: null,
  ...over,
});

describe('validateActionArgs — post_payment', () => {
  it('accepts a cash payment with no cheque status', () => {
    expect(validateActionArgs('post_payment', payment())).toEqual([]);
  });

  it('rejects a cheque with no status, naming the field', () => {
    const problems = validateActionArgs('post_payment', payment({ method: 'cheque' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('chequeStatus');
    expect(problems[0]).toContain('received, deposited, cleared, bounced');
  });

  it('accepts a cheque with a status', () => {
    expect(
      validateActionArgs('post_payment', payment({ method: 'cheque', chequeStatus: 'deposited' })),
    ).toEqual([]);
  });

  it('rejects a cheque status on a non-cheque payment', () => {
    const problems = validateActionArgs(
      'post_payment',
      payment({ method: 'cliq', chequeStatus: 'cleared' }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot carry one');
  });

  it('rejects a fractional or non-positive amount', () => {
    expect(validateActionArgs('post_payment', payment({ amountFils: 12.5 }))[0]).toContain(
      'positive integer',
    );
    expect(validateActionArgs('post_payment', payment({ amountFils: 0 }))[0]).toContain(
      'positive integer',
    );
    expect(validateActionArgs('post_payment', payment({ amountFils: '125000' }))[0]).toContain(
      'positive integer',
    );
  });

  it('rejects an unknown method and a malformed date', () => {
    const problems = validateActionArgs(
      'post_payment',
      payment({ method: 'cheque-note', receivedDate: '21/11/2026' }),
    );
    expect(problems.some((p) => p.includes('"method"'))).toBe(true);
    expect(problems.some((p) => p.includes('receivedDate'))).toBe(true);
  });

  it('has no opinion about actions it does not know', () => {
    expect(validateActionArgs('approve_lease', { anything: true })).toEqual([]);
  });
});

describe('validateActionArgs — allocations', () => {
  const withAllocations = (allocations: unknown): Record<string, unknown> => ({
    leaseId: 'lease-1',
    amountFils: 125_000,
    method: 'cash',
    receivedDate: '2026-11-21',
    allocations,
  });

  it('accepts a well-formed list that fits inside the payment', () => {
    expect(
      validateActionArgs(
        'post_payment',
        withAllocations([
          { chargeId: 'charge-1', amountFils: 100_000 },
          { chargeId: 'charge-2', amountFils: 25_000 },
        ]),
      ),
    ).toEqual([]);
  });

  it('rejects a list that over-applies the payment, with both numbers', () => {
    const problems = validateActionArgs(
      'post_payment',
      withAllocations([{ chargeId: 'c', amountFils: 200_000 }]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(
      'allocations total 200000 fils exceeds the payment amount 125000 fils',
    );
  });

  it('rejects a non-array, a non-object entry, and a bad amount', () => {
    expect(validateActionArgs('post_payment', withAllocations('everything'))[0]).toContain(
      'must be an array',
    );
    expect(validateActionArgs('post_payment', withAllocations(['charge-1']))[0]).toContain(
      'allocations[0] must be an object',
    );
    expect(
      validateActionArgs('post_payment', withAllocations([{ chargeId: 'c', amountFils: 0 }]))[0],
    ).toContain('positive integer');
    expect(validateActionArgs('post_payment', withAllocations([{ amountFils: 10 }]))[0]).toContain(
      'chargeId',
    );
  });
});

describe('validateActionArgs — dispatch_vendor', () => {
  it('accepts a dispatch with an optional ceiling', () => {
    expect(validateActionArgs('dispatch_vendor', { ticketId: 't-1', vendorId: 'v-1' })).toEqual([]);
    expect(
      validateActionArgs('dispatch_vendor', {
        ticketId: 't-1',
        vendorId: 'v-1',
        amountFils: 60_000,
      }),
    ).toEqual([]);
  });

  it('requires both ids and refuses a fractional ceiling', () => {
    const problems = validateActionArgs('dispatch_vendor', { amountFils: 600.5 });
    expect(problems.some((p) => p.includes('ticketId'))).toBe(true);
    expect(problems.some((p) => p.includes('vendorId'))).toBe(true);
    expect(problems.some((p) => p.includes('positive integer'))).toBe(true);
  });
});
