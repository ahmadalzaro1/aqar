import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_POLICY_LIMITS, evaluateProposal, type PolicyLimits } from './limits.js';

const payment = (over: Record<string, unknown> = {}) => ({
  action: 'post_payment',
  role: 'accountant',
  args: { leaseId: 'lease-1', amountFils: 250_000, receivedDate: '2026-11-20', method: 'cliq', ...over },
});

const dispatch = (over: Record<string, unknown> = {}) => ({
  action: 'dispatch_vendor',
  role: 'property_manager',
  args: { ticketId: 'ticket-1', vendorId: 'vendor-1', amountFils: 40_000, ...over },
});

const ruleOf = (decision: ReturnType<typeof evaluateProposal>, name: string) =>
  decision.rules.find((r) => r.rule === name);

describe('evaluateProposal — the default posture', () => {
  it('requires a human for a well-formed payment', () => {
    const decision = evaluateProposal(payment());
    expect(decision.verdict).toBe('approve_required');
    expect(ruleOf(decision, 'limit.auto_approve')?.verdict).toBe('approve_required');
  });

  it('ships with nothing auto-approvable', () => {
    expect(DEFAULT_POLICY_LIMITS.autoApproveUnderFils).toBe(0);
    expect(evaluateProposal(payment({ amountFils: 1 })).verdict).toBe('approve_required');
  });

  it('allows below a configured threshold once one is set', () => {
    const limits: PolicyLimits = { ...DEFAULT_POLICY_LIMITS, autoApproveUnderFils: 5_000 };
    expect(evaluateProposal({ ...payment({ amountFils: 5_000 }), limits }).verdict).toBe('allow');
    expect(evaluateProposal({ ...payment({ amountFils: 5_001 }), limits }).verdict).toBe('approve_required');
  });
});

describe('evaluateProposal — refusals', () => {
  it('denies a non-approver even with a perfect proposal', () => {
    const decision = evaluateProposal({ ...payment(), role: 'leasing_agent' });
    expect(decision.verdict).toBe('deny');
    expect(ruleOf(decision, 'role.approver')?.detail).toContain('not an approver');
  });

  it('denies an action that has no policy', () => {
    expect(evaluateProposal({ action: 'send_everyone_a_gift', role: 'owner_admin', args: {} }).verdict).toBe('deny');
  });

  it('denies a fractional or zero amount', () => {
    expect(evaluateProposal(payment({ amountFils: 12.5 })).verdict).toBe('deny');
    expect(evaluateProposal(payment({ amountFils: 0 })).verdict).toBe('deny');
    expect(evaluateProposal(payment({ amountFils: -250_000 })).verdict).toBe('deny');
  });

  it('denies a malformed date and an unknown method', () => {
    expect(evaluateProposal(payment({ receivedDate: '20/11/2026' })).verdict).toBe('deny');
    expect(evaluateProposal(payment({ method: 'IOU' })).verdict).toBe('deny');
  });

  it('denies allocations that exceed the receipt', () => {
    const decision = evaluateProposal(payment({ allocations: [{ chargeId: 'c1', amountFils: 200_000 }, { chargeId: 'c2', amountFils: 60_000 }] }));
    expect(decision.verdict).toBe('deny');
    expect(ruleOf(decision, 'args.allocations')?.detail).toContain('exceeds');
  });

  it('accepts allocations that fit', () => {
    expect(evaluateProposal(payment({ allocations: [{ chargeId: 'c1', amountFils: 250_000 }] })).verdict).toBe('approve_required');
  });

  it('denies a dispatch above the NTE ceiling and allows one below it', () => {
    const over = evaluateProposal(dispatch({ amountFils: DEFAULT_POLICY_LIMITS.nteCeilingFils + 1 }));
    expect(over.verdict).toBe('deny');
    expect(ruleOf(over, 'limit.nte_ceiling')?.detail).toContain('dispatch ceiling');
    expect(evaluateProposal(dispatch()).verdict).toBe('approve_required');
  });

  it('still needs a human for a dispatch with no NTE at all', () => {
    const decision = evaluateProposal(dispatch({ amountFils: undefined }));
    expect(decision.verdict).toBe('approve_required');
    expect(ruleOf(decision, 'args.amountFils')?.detail).toBe('no NTE set');
    expect(ruleOf(decision, 'limit.dispatch_human')?.verdict).toBe('approve_required');
  });
});

describe('evaluateProposal — properties', () => {
  it('never allows a positive payment when the threshold is zero', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_000 }), (amountFils) => {
        const decision = evaluateProposal(payment({ amountFils }));
        expect(decision.verdict).not.toBe('allow');
      }),
      { numRuns: 200 },
    );
  });

  it('never returns allow while any rule denies', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 10_000 }),
        fc.constantFrom('cash', 'cliq', 'bank_transfer', 'cheque', 'IOU', ''),
        (amountFils, method) => {
          const decision = evaluateProposal(payment({ amountFils, method }));
          const anyDeny = decision.rules.some((r) => r.verdict === 'deny');
          if (anyDeny) expect(decision.verdict).toBe('deny');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('names at least one decisive rule whenever it denies', () => {
    fc.assert(
      fc.property(fc.anything(), (role) => {
        const decision = evaluateProposal({ ...payment(), role: typeof role === 'string' ? role : 'nobody' });
        if (decision.verdict === 'deny') expect(decision.decisive.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});
