import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_LIMITS, type PolicyLimits } from './limits.js';
import { RULE_CATALOGUE, cataloguedRule, compilePolicy, policyVersion } from './compile.js';

/**
 * The version's job is to make a stored decision replayable: given the stamp, you
 * should be able to say which predicate produced it. That only holds if the stamp
 * changes whenever *anything* that can change an answer does.
 *
 * These tests cover the three inputs the version hashes — the numbers, the rule
 * catalogue, and what the rules actually do — and the one invariant that keeps the
 * catalogue honest: it can neither miss a rule the predicate emits nor keep a rule
 * that no longer fires.
 */

const base = DEFAULT_POLICY_LIMITS;

/** Every rule id observed across a battery of scenarios and several limit shapes. */
function observedRules(): readonly string[] {
  const shapes: readonly PolicyLimits[] = [
    base,
    // No dual-control threshold: `concurrence.dual_control` instead of the
    // distinct-approvers rule.
    { ...base, dualControlAboveFils: null },
    // Auto-approval enabled, so the `limit.auto_approve` branch fires.
    { ...base, autoApproveUnderFils: 200_000, dualControlAboveFils: null },
  ];
  const lease = '00000000-0000-4000-8000-000000000001';
  const args = (over: Record<string, unknown>): Record<string, unknown> => ({
    leaseId: lease,
    receivedDate: '2026-01-01',
    reference: 'P',
    note: null,
    ...over,
  });
  const seen = new Set<string>();
  const record = (facts: Parameters<ReturnType<typeof compilePolicy>['decide']>[0]): void => {
    for (const shape of shapes) for (const rule of compilePolicy(shape).decide(facts).rules) seen.add(rule.rule);
  };

  record({ kind: 'proposal', action: 'unheard_of', args: {}, role: 'accountant' });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: 100_000, method: 'cliq' }), role: 'accountant' });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: 100_000, method: 'cheque' }), role: 'accountant' });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: 100_000, method: 'cash', allocations: [{ chargeId: 'c', amountFils: 1 }] }), role: 'accountant' });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: 100_000, method: 'cash' }), role: 'accountant' });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: base.nteCeilingFils + 1, method: 'cash' }), role: 'accountant' });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: 1, method: 'cash' }), role: 'accountant' });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: 450_000, method: 'cash' }), role: 'accountant' });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: 450_000, method: 'cash' }), role: 'accountant', actorId: 'u-1', requester: { kind: 'human', userId: 'u-1' } });
  record({ kind: 'proposal', action: 'post_payment', args: args({ amountFils: 450_000, method: 'cash' }), role: 'accountant', actorId: 'u-1', requester: { kind: 'agent' }, approvals: [{ userId: 'u-2' }, { userId: 'u-3' }] });
  record({ kind: 'proposal', action: 'dispatch_vendor', args: { ticketId: 't', vendorId: 'v' }, role: 'accountant' });
  record({ kind: 'proposal', action: 'dispatch_vendor', args: { ticketId: 't', vendorId: 'v' }, role: 'property_manager' });
  record({ kind: 'proposal', action: 'dispatch_vendor', args: { ticketId: 't', vendorId: 'v', amountFils: base.nteCeilingFils + 1 }, role: 'property_manager' });
  record({ kind: 'reversal', action: 'post_payment', role: 'accountant', actorId: 'u-1', executedAt: '2026-05-01T00:00:00.000Z', now: '2026-06-01T00:00:00.000Z' });
  record({ kind: 'reversal', action: 'post_payment', role: 'accountant', actorId: 'u-1', executedAt: '2025-01-01T00:00:00.000Z', now: '2026-06-01T00:00:00.000Z' });
  record({ kind: 'reversal', action: 'post_payment', role: 'viewer', actorId: 'u-1', executedAt: '2026-05-01T00:00:00.000Z', now: '2026-06-01T00:00:00.000Z' });
  record({ kind: 'reversal', action: 'unheard_of', role: 'accountant', actorId: 'u-1', executedAt: '2026-05-01T00:00:00.000Z', now: '2026-06-01T00:00:00.000Z' });
  record({ kind: 'reversal', action: 'post_payment', role: 'accountant', actorId: 'u-1', executedAt: 'not a date', now: '2026-06-01T00:00:00.000Z' });

  return [...seen].sort();
}

describe('policy identity — the version covers more than the numbers', () => {
  it('does not equal the limits-only version, so the predicate is part of the name', () => {
    const compiled = compilePolicy(base);
    expect(compiled.version).toMatch(/^[0-9a-f]{12}$/);
    // A direct caller has measured nothing and must not be able to claim the
    // identity of a real policy.
    expect(compiled.version).not.toBe(policyVersion(base));
  });

  it('is stable for the same limits and the same predicate', () => {
    expect(compilePolicy(base).version).toBe(compilePolicy({ ...base }).version);
  });

  it('changes with the numbers, including the ones that only permit', () => {
    const v = compilePolicy(base).version;
    expect(compilePolicy({ ...base, nteCeilingFils: base.nteCeilingFils + 1 }).version).not.toBe(v);
    expect(compilePolicy({ ...base, dualControlAboveFils: 1_000 }).version).not.toBe(v);
    expect(compilePolicy({ ...base, policyEditorRoles: [...base.policyEditorRoles, 'accountant'] }).version).not.toBe(v);
  });

  it('folds behaviour in: two measured fingerprints give two versions', () => {
    expect(policyVersion(base, 'a')).not.toBe(policyVersion(base, 'b'));
  });
});

describe('rule catalogue — complete, and free of dead entries', () => {
  const observed = observedRules();

  it('declares every rule id the predicate can emit', () => {
    const undeclared = observed.filter((id) => !cataloguedRule(id));
    expect(undeclared).toEqual([]);
  });

  it('has no entry that never fires', () => {
    const dead = RULE_CATALOGUE.filter((entry) =>
      entry.endsWith('.*')
        ? !observed.some((id) => id.startsWith(entry.slice(0, -1)))
        : !observed.includes(entry),
    );
    expect(dead).toEqual([]);
  });

  it('actually exercises the interesting branches (a battery that proves nothing is a battery that catches nothing)', () => {
    expect(observed).toContain('sod.requester_not_approver');
    expect(observed).toContain('concurrence.distinct_approvers');
    expect(observed).toContain('concurrence.dual_control');
    expect(observed).toContain('reversal.window');
    expect(observed.some((id) => id.startsWith('args.'))).toBe(true);
  });
});
