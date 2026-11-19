import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PolicyAction, PolicyInput } from '@aqar/contracts';
import { evaluatePolicy } from './policy.js';

const ACTIONS: PolicyAction[] = [
  'dispatch_vendor', 'post_payment', 'approve_quote', 'send_tenant_message',
  'create_charge', 'move_money', 'award_work', 'draft_only',
];

const DENIAL = new Set(['dry_run', 'approval_token_required', 'vendor_not_allowlisted', 'owner_approval_pending', 'quiet_hours', 'frequency_cap', 'spend_cap']);
const VOCAB = new Set([...DENIAL, 'nte_exceeded']);

const arbInput: fc.Arbitrary<PolicyInput> = fc.record({
  action: fc.constantFrom(...ACTIONS),
  orgId: fc.constant('org-1'),
  propertyId: fc.constant('prop-1'),
  actor: fc.constant('agent:classifier'),
  mode: fc.constantFrom('dry_run' as const, 'live' as const),
  amountFils: fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null }),
  vendorId: fc.option(fc.constant('vendor-1'), { nil: null }),
  vendorOnAllowList: fc.boolean(),
  nteLimitFils: fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null }),
  approvalRequiredN: fc.integer({ min: 0, max: 6 }),
  approvalRequiredM: fc.integer({ min: 0, max: 6 }),
  approvalVotesYes: fc.integer({ min: 0, max: 6 }),
  localHour: fc.integer({ min: 0, max: 23 }),
  quietHoursStart: fc.integer({ min: 0, max: 23 }),
  quietHoursEnd: fc.integer({ min: 0, max: 23 }),
  tenantMessagesToday: fc.integer({ min: 0, max: 10 }),
  tenantMessageDailyCap: fc.integer({ min: 0, max: 10 }),
  orgSpendTodayFils: fc.integer({ min: 0, max: 10_000_000 }),
  orgDailySpendCapFils: fc.integer({ min: 0, max: 10_000_000 }),
  humanApprovalTokenPresent: fc.boolean(),
});

describe('policy properties', () => {
  it('draft_only is ALWAYS allowed, whatever the other inputs', () => {
    fc.assert(fc.property(arbInput, (input) => {
      const decision = evaluatePolicy({ ...input, action: 'draft_only' });
      expect(decision.allowed).toBe(true);
      expect(decision.requiresHumanApproval).toBe(false);
      expect(decision.reasons).toEqual([]);
    }), { numRuns: 500 });
  });

  it('dry_run denies every mutating action, with dry_run as the first reason', () => {
    fc.assert(fc.property(arbInput, (input) => {
      if (input.action === 'draft_only') return;
      const decision = evaluatePolicy({ ...input, mode: 'dry_run' });
      expect(decision.allowed).toBe(false);
      expect(decision.reasons[0]).toBe('dry_run');
    }), { numRuns: 500 });
  });

  it('allowed decisions carry no denial reason; denied decisions always cite one', () => {
    fc.assert(fc.property(arbInput, (input) => {
      const decision = evaluatePolicy(input);
      const denials = decision.reasons.filter((r) => DENIAL.has(r));
      if (decision.allowed) expect(denials).toEqual([]);
      else expect(denials.length).toBeGreaterThan(0);
    }), { numRuns: 500 });
  });

  it('is deterministic: identical inputs give identical decisions', () => {
    fc.assert(fc.property(arbInput, (input) => {
      expect(evaluatePolicy(input)).toEqual(evaluatePolicy(input));
    }), { numRuns: 300 });
  });

  it('moving money in live mode always requires a human approval token', () => {
    fc.assert(fc.property(arbInput, (input) => {
      const decision = evaluatePolicy({ ...input, mode: 'live', action: 'post_payment', humanApprovalTokenPresent: false });
      expect(decision.allowed).toBe(false);
      expect(decision.reasons).toContain('approval_token_required');
    }), { numRuns: 300 });
  });

  it('reason codes are unique and drawn from the frozen vocabulary', () => {
    fc.assert(fc.property(arbInput, (input) => {
      const decision = evaluatePolicy(input);
      expect(new Set(decision.reasons).size).toBe(decision.reasons.length);
      for (const reason of decision.reasons) expect(VOCAB.has(reason)).toBe(true);
    }), { numRuns: 300 });
  });

  it('NTE overrun is advisory: allowed with a human-approval flag, never a silent pass', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 5_000_000 }),
      fc.integer({ min: 0, max: 5_000_000 }),
      (amount, limit) => {
        fc.pre(amount > limit);
        const decision = evaluatePolicy({
          action: 'approve_quote', orgId: 'o', propertyId: 'p', actor: 'agent:x',
          mode: 'live', amountFils: amount, vendorId: null, vendorOnAllowList: true,
          nteLimitFils: limit, approvalRequiredN: 0, approvalRequiredM: 0, approvalVotesYes: 0,
          localHour: 12, quietHoursStart: 22, quietHoursEnd: 7,
          tenantMessagesToday: 0, tenantMessageDailyCap: 3,
          orgSpendTodayFils: 0, orgDailySpendCapFils: 100_000_000,
          humanApprovalTokenPresent: true,
        });
        expect(decision.reasons).toContain('nte_exceeded');
        expect(decision.requiresHumanApproval).toBe(true);
      },
    ), { numRuns: 200 });
  });
});
