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
    expect(validateActionArgs('post_payment', payment({ method: 'cheque', chequeStatus: 'deposited' }))).toEqual([]);
  });

  it('rejects a cheque status on a non-cheque payment', () => {
    const problems = validateActionArgs('post_payment', payment({ method: 'cliq', chequeStatus: 'cleared' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot carry one');
  });

  it('rejects a fractional or non-positive amount', () => {
    expect(validateActionArgs('post_payment', payment({ amountFils: 12.5 }))[0]).toContain('positive integer');
    expect(validateActionArgs('post_payment', payment({ amountFils: 0 }))[0]).toContain('positive integer');
    expect(validateActionArgs('post_payment', payment({ amountFils: '125000' }))[0]).toContain('positive integer');
  });

  it('rejects an unknown method and a malformed date', () => {
    const problems = validateActionArgs('post_payment', payment({ method: 'cheque-note', receivedDate: '21/11/2026' }));
    expect(problems.some((p) => p.includes('"method"'))).toBe(true);
    expect(problems.some((p) => p.includes('receivedDate'))).toBe(true);
  });

  it('has no opinion about actions it does not know', () => {
    expect(validateActionArgs('dispatch_vendor', { anything: true })).toEqual([]);
  });
});
