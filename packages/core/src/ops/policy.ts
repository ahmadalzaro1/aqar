// Deterministic action policy. Agents draft; humans approve.
//
// Every applicable rule contributes a reason; the decision is the accumulated
// verdict, never the first rule that fires. Same input -> same output, always.
//
// Boundary of this module (important): emergency fast dispatch is an ORCHESTRATOR
// concern. An emergency pages a human immediately and pre-empts the queue; it is
// NOT a policy bypass. Nothing here can be short-circuited by a ticket being an
// emergency, and no free-text field is ever consulted — text cannot buy permission.

import type { PolicyAction, PolicyDecision, PolicyInput } from '@aqar/contracts';

/** Reasons that deny the action outright. */
const DENIAL_REASONS: ReadonlySet<string> = new Set([
  'dry_run',
  'approval_token_required',
  'vendor_not_allowlisted',
  'owner_approval_pending',
  'quiet_hours',
  'frequency_cap',
  'spend_cap',
]);

const MONEY_MOVING: ReadonlySet<PolicyAction> = new Set<PolicyAction>([
  'move_money',
  'post_payment',
]);
const VENDOR_COMMITTING: ReadonlySet<PolicyAction> = new Set<PolicyAction>([
  'dispatch_vendor',
  'award_work',
]);
const TENANT_CONTACT: ReadonlySet<PolicyAction> = new Set<PolicyAction>(['send_tenant_message']);

/**
 * True when the action changes state outside the agent's own draft space.
 * `draft_only` is the only non-mutating action: it writes a proposal, commits no
 * money, contacts nobody, and is therefore always allowed.
 */
function isMutating(action: PolicyAction): boolean {
  return action !== 'draft_only';
}

/**
 * Quiet-hours test. The window may wrap midnight (start 22, end 7). Start === end
 * is an empty window: the property has disabled quiet hours.
 */
function inQuietHours(localHour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return localHour >= start && localHour < end;
  return localHour >= start || localHour < end;
}

/**
 * Evaluate one proposed action against org/property policy inputs.
 *
 * Reason vocabulary (stable, machine-readable):
 *   dry_run | approval_token_required | vendor_not_allowlisted | nte_exceeded
 *   owner_approval_pending | quiet_hours | frequency_cap | spend_cap
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const action = input.action;
  const mutating = isMutating(action);

  // A draft commits nothing, touches nobody, and is always allowed.
  if (!mutating) {
    return { allowed: true, requiresHumanApproval: false, reasons: [] };
  }

  const reasons: string[] = [];
  let requiresHumanApproval = false;

  // 1. Dry run: the agent may draft anything, but may not commit. A human enables
  //    live mode per property; until then every mutating action stops here.
  if (input.mode === 'dry_run') {
    reasons.push('dry_run');
    requiresHumanApproval = true;
  }

  // 2. Money movement needs an explicit human approval token.
  if (MONEY_MOVING.has(action) && !input.humanApprovalTokenPresent) {
    reasons.push('approval_token_required');
  }

  // 3. Vendor commitment needs an allow-listed vendor.
  if (VENDOR_COMMITTING.has(action) && !input.vendorOnAllowList) {
    reasons.push('vendor_not_allowlisted');
  }

  // 4. Not-to-exceed: above the property limit is allowed only with a human.
  if (
    input.amountFils !== null &&
    input.nteLimitFils !== null &&
    input.amountFils > input.nteLimitFils
  ) {
    reasons.push('nte_exceeded');
    requiresHumanApproval = true;
  }

  // 5. N-of-M owner/heir approvals must be satisfied before committing.
  if (
    input.approvalRequiredM > 0 &&
    input.approvalRequiredN > 0 &&
    input.approvalVotesYes < input.approvalRequiredN
  ) {
    reasons.push('owner_approval_pending');
  }

  // 6/7. Tenant contact: quiet hours and the daily message frequency cap.
  if (TENANT_CONTACT.has(action)) {
    if (inQuietHours(input.localHour, input.quietHoursStart, input.quietHoursEnd)) {
      reasons.push('quiet_hours');
    }
    if (input.tenantMessagesToday >= input.tenantMessageDailyCap) {
      reasons.push('frequency_cap');
    }
  }

  // 8. Org daily spend cap, applied to any action that commits an amount.
  if (
    input.amountFils !== null &&
    input.orgSpendTodayFils + input.amountFils > input.orgDailySpendCapFils
  ) {
    reasons.push('spend_cap');
  }

  const allowed = !reasons.some((reason) => DENIAL_REASONS.has(reason));
  return { allowed, requiresHumanApproval: requiresHumanApproval || !allowed, reasons };
}
