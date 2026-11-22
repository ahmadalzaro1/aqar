import { describe, expect, it } from 'vitest';
import type { PolicyInput } from '@aqar/contracts';
import { evaluatePolicy } from './policy.js';

/** A permissive baseline: live mode, allow-listed vendor, token present, wide limits. */
function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    action: 'create_charge',
    orgId: 'org_1',
    propertyId: 'prop_1',
    actor: 'agent:ops',
    mode: 'live',
    amountFils: 1000,
    vendorId: 'vendor_1',
    vendorOnAllowList: true,
    nteLimitFils: 50_000,
    approvalRequiredN: 0,
    approvalRequiredM: 0,
    approvalVotesYes: 0,
    localHour: 10,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    tenantMessagesToday: 0,
    tenantMessageDailyCap: 5,
    orgSpendTodayFils: 0,
    orgDailySpendCapFils: 1_000_000,
    humanApprovalTokenPresent: true,
    ...overrides,
  };
}

const DENIAL = { allowed: false } as const;

describe('evaluatePolicy — draft_only', () => {
  it('is always allowed, with no reasons, even against every hostile input', () => {
    const decision = evaluatePolicy(
      input({
        action: 'draft_only',
        mode: 'dry_run',
        vendorOnAllowList: false,
        amountFils: 9_999_999,
        nteLimitFils: 1,
        approvalRequiredM: 3,
        approvalRequiredN: 3,
        approvalVotesYes: 0,
        localHour: 23,
        tenantMessagesToday: 99,
        tenantMessageDailyCap: 1,
        orgSpendTodayFils: 5_000_000,
        orgDailySpendCapFils: 1,
        humanApprovalTokenPresent: false,
      }),
    );
    expect(decision).toEqual({ allowed: true, requiresHumanApproval: false, reasons: [] });
  });
});

describe('evaluatePolicy — dry_run gate', () => {
  it('denies every mutating action in dry_run and asks for a human', () => {
    const mutating: ReadonlyArray<PolicyInput['action']> = [
      'dispatch_vendor',
      'post_payment',
      'approve_quote',
      'send_tenant_message',
      'create_charge',
      'move_money',
      'award_work',
    ];
    for (const action of mutating) {
      const decision = evaluatePolicy(input({ action, mode: 'dry_run' }));
      expect(decision.allowed, action).toBe(false);
      expect(decision.requiresHumanApproval, action).toBe(true);
      expect(decision.reasons, action).toContain('dry_run');
    }
  });

  it('allows a clean mutating action in live mode', () => {
    const decision = evaluatePolicy(input({ action: 'create_charge' }));
    expect(decision).toEqual({ allowed: true, requiresHumanApproval: false, reasons: [] });
  });
});

describe('evaluatePolicy — money movement needs a token', () => {
  it('denies move_money without a human approval token', () => {
    const decision = evaluatePolicy(
      input({ action: 'move_money', humanApprovalTokenPresent: false }),
    );
    expect(decision).toMatchObject(DENIAL);
    expect(decision.reasons).toEqual(['approval_token_required']);
    expect(decision.requiresHumanApproval).toBe(true);
  });

  it('denies post_payment without a human approval token', () => {
    const decision = evaluatePolicy(
      input({ action: 'post_payment', humanApprovalTokenPresent: false }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('approval_token_required');
  });

  it('allows move_money when the token is present and nothing else blocks', () => {
    expect(evaluatePolicy(input({ action: 'move_money' })).allowed).toBe(true);
  });
});

describe('evaluatePolicy — vendor allow-list', () => {
  it('denies dispatch_vendor to a vendor outside the allow-list', () => {
    const decision = evaluatePolicy(input({ action: 'dispatch_vendor', vendorOnAllowList: false }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(['vendor_not_allowlisted']);
  });

  it('denies award_work to a vendor outside the allow-list', () => {
    const decision = evaluatePolicy(input({ action: 'award_work', vendorOnAllowList: false }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('vendor_not_allowlisted');
  });

  it('allows dispatch_vendor to an allow-listed vendor', () => {
    expect(evaluatePolicy(input({ action: 'dispatch_vendor' })).allowed).toBe(true);
  });
});

describe('evaluatePolicy — not-to-exceed', () => {
  it('flags nte_exceeded and requires a human above the limit, without denying', () => {
    const decision = evaluatePolicy(input({ amountFils: 60_000, nteLimitFils: 50_000 }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresHumanApproval).toBe(true);
    expect(decision.reasons).toEqual(['nte_exceeded']);
  });

  it('does not flag exactly at the limit', () => {
    expect(evaluatePolicy(input({ amountFils: 50_000, nteLimitFils: 50_000 })).reasons).toEqual([]);
  });

  it('skips the check when the property has no NTE limit', () => {
    expect(
      evaluatePolicy(
        input({ amountFils: 9_000_000, nteLimitFils: null, orgDailySpendCapFils: 100_000_000 }),
      ).reasons,
    ).toEqual([]);
  });

  it('skips the check when no amount is committed', () => {
    expect(
      evaluatePolicy(input({ action: 'send_tenant_message', amountFils: null, nteLimitFils: 1 }))
        .reasons,
    ).toEqual([]);
  });
});

describe('evaluatePolicy — N-of-M owner approvals', () => {
  it('denies while owner approvals are pending', () => {
    const decision = evaluatePolicy(
      input({
        action: 'approve_quote',
        approvalRequiredM: 3,
        approvalRequiredN: 2,
        approvalVotesYes: 1,
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('owner_approval_pending');
  });

  it('allows once the required votes are in', () => {
    const decision = evaluatePolicy(
      input({
        action: 'approve_quote',
        approvalRequiredM: 3,
        approvalRequiredN: 2,
        approvalVotesYes: 2,
      }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('does nothing when no approval group is configured', () => {
    expect(evaluatePolicy(input({ approvalRequiredM: 0, approvalRequiredN: 0 })).reasons).toEqual(
      [],
    );
  });
});

describe('evaluatePolicy — quiet hours', () => {
  it('denies a tenant message inside a window that wraps midnight', () => {
    for (const hour of [22, 23, 0, 3, 6]) {
      const decision = evaluatePolicy(
        input({
          action: 'send_tenant_message',
          localHour: hour,
          quietHoursStart: 22,
          quietHoursEnd: 7,
        }),
      );
      expect(decision.allowed, `hour ${hour}`).toBe(false);
      expect(decision.reasons, `hour ${hour}`).toContain('quiet_hours');
    }
  });

  it('allows a tenant message at the end of a wrapping window (end is exclusive)', () => {
    const decision = evaluatePolicy(
      input({ action: 'send_tenant_message', localHour: 7, quietHoursStart: 22, quietHoursEnd: 7 }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('handles a same-day window', () => {
    const quiet = evaluatePolicy(
      input({ action: 'send_tenant_message', localHour: 9, quietHoursStart: 9, quietHoursEnd: 17 }),
    );
    expect(quiet.allowed).toBe(false);
    const ok = evaluatePolicy(
      input({
        action: 'send_tenant_message',
        localHour: 17,
        quietHoursStart: 9,
        quietHoursEnd: 17,
      }),
    );
    expect(ok.allowed).toBe(true);
    const before = evaluatePolicy(
      input({ action: 'send_tenant_message', localHour: 8, quietHoursStart: 9, quietHoursEnd: 17 }),
    );
    expect(before.allowed).toBe(true);
  });

  it('treats start === end as "quiet hours disabled"', () => {
    const decision = evaluatePolicy(
      input({ action: 'send_tenant_message', localHour: 3, quietHoursStart: 0, quietHoursEnd: 0 }),
    );
    expect(decision.reasons).toEqual([]);
  });

  it('applies quiet hours only to tenant contact', () => {
    const decision = evaluatePolicy(
      input({ action: 'create_charge', localHour: 23, quietHoursStart: 22, quietHoursEnd: 7 }),
    );
    expect(decision.reasons).not.toContain('quiet_hours');
  });
});

describe('evaluatePolicy — tenant message frequency cap', () => {
  it('denies at or above the daily cap', () => {
    const atCap = evaluatePolicy(
      input({ action: 'send_tenant_message', tenantMessagesToday: 5, tenantMessageDailyCap: 5 }),
    );
    expect(atCap.allowed).toBe(false);
    expect(atCap.reasons).toContain('frequency_cap');

    const overCap = evaluatePolicy(
      input({ action: 'send_tenant_message', tenantMessagesToday: 9, tenantMessageDailyCap: 5 }),
    );
    expect(overCap.reasons).toContain('frequency_cap');
  });

  it('allows below the cap', () => {
    const decision = evaluatePolicy(
      input({ action: 'send_tenant_message', tenantMessagesToday: 4, tenantMessageDailyCap: 5 }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('evaluatePolicy — org daily spend cap', () => {
  it('denies when today plus this action exceeds the cap', () => {
    const decision = evaluatePolicy(
      input({ amountFils: 30_000, orgSpendTodayFils: 990_000, orgDailySpendCapFils: 1_000_000 }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('spend_cap');
  });

  it('allows exactly up to the cap', () => {
    const decision = evaluatePolicy(
      input({ amountFils: 10_000, orgSpendTodayFils: 990_000, orgDailySpendCapFils: 1_000_000 }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('ignores the cap when no amount is committed', () => {
    const decision = evaluatePolicy(
      input({
        action: 'send_tenant_message',
        amountFils: null,
        orgSpendTodayFils: 5_000_000,
        orgDailySpendCapFils: 1,
      }),
    );
    expect(decision.reasons).not.toContain('spend_cap');
  });
});

describe('evaluatePolicy — accumulation and determinism', () => {
  it('accumulates every applicable reason, in a stable order', () => {
    const decision = evaluatePolicy(
      input({
        action: 'award_work',
        mode: 'dry_run',
        vendorOnAllowList: false,
        amountFils: 80_000,
        nteLimitFils: 50_000,
        approvalRequiredM: 3,
        approvalRequiredN: 2,
        approvalVotesYes: 0,
        orgSpendTodayFils: 990_000,
        orgDailySpendCapFils: 1_000_000,
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.requiresHumanApproval).toBe(true);
    expect(decision.reasons).toEqual([
      'dry_run',
      'vendor_not_allowlisted',
      'nte_exceeded',
      'owner_approval_pending',
      'spend_cap',
    ]);
  });

  it('collects quiet-hours and frequency reasons together', () => {
    const decision = evaluatePolicy(
      input({
        action: 'send_tenant_message',
        localHour: 23,
        quietHoursStart: 22,
        quietHoursEnd: 7,
        tenantMessagesToday: 7,
        tenantMessageDailyCap: 5,
      }),
    );
    expect(decision.reasons).toEqual(['quiet_hours', 'frequency_cap']);
  });

  it('is deterministic for identical input', () => {
    const base = input({ action: 'move_money', humanApprovalTokenPresent: false });
    expect(evaluatePolicy(base)).toEqual(evaluatePolicy({ ...base }));
  });

  it('does not mutate its input', () => {
    const base = input({ action: 'award_work', mode: 'dry_run' });
    const snapshot = JSON.parse(JSON.stringify(base)) as PolicyInput;
    evaluatePolicy(base);
    expect(base).toEqual(snapshot);
  });
});
