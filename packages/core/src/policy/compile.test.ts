import { describe, expect, it } from 'vitest';
import { compilePolicy, policyVersion, REVERSIBLE_ACTIONS, type ReversalFacts } from './compile.js';
import { DEFAULT_POLICY_LIMITS, evaluateProposal, type PolicyLimits } from './limits.js';

const payment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  leaseId: 'lease-1',
  amountFils: 125_000,
  receivedDate: '2026-11-21',
  method: 'cash',
  ...over,
});

describe('compilePolicy — the properties a stored decision depends on', () => {
  const policy = compilePolicy();

  it('is deterministic: same facts, byte-identical decision', () => {
    const facts = {
      kind: 'proposal',
      action: 'post_payment',
      args: payment(),
      role: 'accountant',
    } as const;
    expect(JSON.stringify(policy.decide(facts))).toBe(JSON.stringify(policy.decide(facts)));
  });

  it('is total: every verdict is one of three, whatever the input', () => {
    const shapes = [
      { kind: 'proposal', action: 'post_payment', args: {}, role: 'nobody' },
      { kind: 'proposal', action: 'unknown_action', args: {}, role: 'accountant' },
      {
        kind: 'proposal',
        action: 'dispatch_vendor',
        args: { ticketId: 't', vendorId: 'v', amountFils: 10 },
        role: 'accountant',
      },
      {
        kind: 'reversal',
        action: 'post_payment',
        role: 'accountant',
        actorId: 'u1',
        executedAt: '2026-11-21T00:00:00Z',
        now: '2026-11-21T01:00:00Z',
      },
      {
        kind: 'reversal',
        action: 'post_payment',
        role: 'accountant',
        actorId: 'u1',
        executedAt: 'not a date',
        now: 'also not',
      },
    ] as const;
    for (const facts of shapes) {
      expect(['allow', 'approve_required', 'deny']).toContain(policy.decide(facts).verdict);
    }
  });

  it('forbid overrides: a denied role is never outvoted by satisfied allows', () => {
    // Every other rule here is satisfied (known action, valid shape, tiny amount).
    const decision = policy.decide({
      kind: 'proposal',
      action: 'post_payment',
      args: payment({ amountFils: 1 }),
      role: 'maintenance_coordinator',
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.decisive.map((r) => r.rule)).toContain('role.approver');
    expect(decision.rules.filter((r) => r.verdict === 'allow').length).toBeGreaterThan(0);
  });

  it('takes no limit argument — the only way to change the answer is a new policy version', () => {
    expect(policy.decide.length).toBe(1);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.limits.approverRoles)).toBe(true);
  });
});

describe('compilePolicy — differential against evaluateProposal', () => {
  it('changes no existing answer', () => {
    const roles = [
      'owner_admin',
      'accountant',
      'property_manager',
      'maintenance_coordinator',
      'viewer',
    ];
    const argSets: Record<string, unknown>[] = [
      payment(),
      payment({ amountFils: 0 }),
      payment({ method: 'crypto' }),
      payment({ receivedDate: '21/11/2026' }),
      payment({ allocations: [{ chargeId: 'c1', amountFils: 200_000 }] }),
      { ticketId: 't1', vendorId: 'v1', amountFils: 600_000 },
      { ticketId: 't1', vendorId: 'v1' },
      {},
    ];
    const actions = ['post_payment', 'dispatch_vendor', 'totally_unknown'];
    const policy = compilePolicy();
    let compared = 0;
    for (const action of actions) {
      for (const args of argSets) {
        for (const role of roles) {
          const expected = evaluateProposal({ action, args, role }).verdict;
          const actual = policy.decide({ kind: 'proposal', action, args, role }).verdict;
          expect(`${action}/${role}/${JSON.stringify(args)} => ${actual}`).toBe(
            `${action}/${role}/${JSON.stringify(args)} => ${expected}`,
          );
          compared++;
        }
      }
    }
    expect(compared).toBe(actions.length * argSets.length * roles.length);
  });
});

describe('policyVersion', () => {
  const base: PolicyLimits = { ...DEFAULT_POLICY_LIMITS };

  it('does not depend on key or role order', () => {
    const reordered: PolicyLimits = {
      requiredApprovers: base.requiredApprovers,
      dualControlAboveFils: base.dualControlAboveFils,
      reversalWindowHours: base.reversalWindowHours,
      autoApproveUnderFils: base.autoApproveUnderFils,
      nteCeilingFils: base.nteCeilingFils,
      approverRoles: [...base.approverRoles],
      policyEditorRoles: [...base.policyEditorRoles],
    };
    expect(policyVersion(reordered)).toBe(policyVersion(base));
  });

  it('changes when a limit changes — an edit cannot masquerade as the old policy', () => {
    expect(policyVersion({ ...base, nteCeilingFils: base.nteCeilingFils + 1 })).not.toBe(
      policyVersion(base),
    );
    expect(policyVersion({ ...base, approverRoles: [...base.approverRoles, 'viewer'] })).not.toBe(
      policyVersion(base),
    );
  });

  it('is a stable 12-hex-digit string', () => {
    expect(policyVersion(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(policyVersion(base)).toBe(policyVersion({ ...base }));
  });
});

describe('separation of duties', () => {
  it('denies a human approving the proposal they filed', () => {
    const decision = compilePolicy().decide({
      kind: 'proposal',
      action: 'post_payment',
      args: payment(),
      role: 'accountant',
      actorId: 'user-7',
      requester: { kind: 'human', userId: 'user-7' },
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.decisive.map((r) => r.rule)).toContain('sod.requester_not_approver');
  });

  it('allows an agent-filed proposal to be approved by any approver', () => {
    const decision = compilePolicy().decide({
      kind: 'proposal',
      action: 'post_payment',
      args: payment(),
      role: 'accountant',
      actorId: 'user-7',
      requester: { kind: 'agent' },
    });
    expect(decision.verdict).toBe('approve_required');
    expect(decision.rules.find((r) => r.rule === 'sod.requester_not_approver')?.verdict).toBe(
      'allow',
    );
  });
});

describe('dual control', () => {
  const withDual: PolicyLimits = {
    ...DEFAULT_POLICY_LIMITS,
    dualControlAboveFils: 100_000,
    requiredApprovers: 2,
  };

  it('states that no threshold is configured rather than implying it', () => {
    // The invariant is that the rule *reports* the configuration; the shipped
    // value is a separate fact, asserted below. An explicit null, not the default.
    const noDual = compilePolicy({ ...DEFAULT_POLICY_LIMITS, dualControlAboveFils: null });
    const decision = noDual.decide({
      kind: 'proposal',
      action: 'post_payment',
      args: payment(),
      role: 'accountant',
    });
    expect(decision.rules.find((r) => r.rule === 'concurrence.dual_control')?.detail).toContain(
      'no dual-control threshold',
    );
  });

  it('ships with dual control above 400 JOD, below the NTE ceiling', () => {
    const shipped = compilePolicy();
    expect(shipped.limits.dualControlAboveFils).toBe(400_000);
    expect(shipped.limits.dualControlAboveFils).toBeLessThan(shipped.limits.nteCeilingFils);
    const one = shipped.decide({
      kind: 'proposal',
      action: 'post_payment',
      args: payment({ amountFils: 450_000 }),
      role: 'accountant',
      approvals: [{ userId: 'user-1' }],
    });
    expect(one.decisive.map((r) => r.rule)).toContain('concurrence.distinct_approvers');
  });

  it('demands a second distinct approver above the threshold', () => {
    const one = compilePolicy(withDual).decide({
      kind: 'proposal',
      action: 'post_payment',
      args: payment(),
      role: 'accountant',
      approvals: [{ userId: 'user-1' }],
    });
    expect(one.verdict).toBe('approve_required');
    expect(one.decisive.map((r) => r.rule)).toContain('concurrence.distinct_approvers');

    const two = compilePolicy(withDual).decide({
      kind: 'proposal',
      action: 'post_payment',
      args: payment(),
      role: 'accountant',
      approvals: [{ userId: 'user-1' }, { userId: 'user-2' }],
    });
    expect(two.verdict).toBe('approve_required'); // still needs a human to actually press it
    expect(two.rules.find((r) => r.rule === 'concurrence.distinct_approvers')?.verdict).toBe(
      'allow',
    );
  });

  it('ignores the threshold below it', () => {
    const decision = compilePolicy(withDual).decide({
      kind: 'proposal',
      action: 'post_payment',
      args: payment({ amountFils: 50_000 }),
      role: 'accountant',
    });
    expect(decision.rules.some((r) => r.rule === 'concurrence.distinct_approvers')).toBe(false);
  });
});

describe('reversal rules', () => {
  const facts = (over: Partial<ReversalFacts> = {}): ReversalFacts => ({
    kind: 'reversal',
    action: 'post_payment',
    role: 'accountant',
    actorId: 'user-1',
    executedAt: '2026-11-21T10:00:00Z',
    now: '2026-11-21T12:00:00Z',
    ...over,
  });

  it('allows an approver to undo a payment inside the window', () => {
    expect(compilePolicy().decide(facts()).verdict).toBe('allow');
  });

  it('refuses outside the window and says what to do instead', () => {
    const decision = compilePolicy().decide(facts({ now: '2026-12-31T00:00:00Z' }));
    expect(decision.verdict).toBe('deny');
    expect(decision.decisive[0]?.detail).toContain('journal entry');
  });

  it('refuses a role that may not approve', () => {
    expect(compilePolicy().decide(facts({ role: 'maintenance_coordinator' })).verdict).toBe('deny');
  });

  it('refuses an action with no reverser', () => {
    const decision = compilePolicy().decide(facts({ action: 'issue_credit_note' }));
    expect(decision.verdict).toBe('deny');
    expect(decision.decisive.map((r) => r.rule)).toContain('reversal.action_known');
  });

  it('covers every action the web reversers implement, and nothing invented', () => {
    expect([...REVERSIBLE_ACTIONS].sort()).toEqual(['dispatch_vendor', 'post_payment']);
  });

  it('refuses unparseable timestamps instead of guessing', () => {
    expect(compilePolicy().decide(facts({ executedAt: 'yesterday' })).verdict).toBe('deny');
  });

  it('permits self-correction, and says so in the record', () => {
    const decision = compilePolicy().decide(facts());
    expect(decision.rules.find((r) => r.rule === 'reversal.self_correction')?.verdict).toBe(
      'allow',
    );
  });
});
