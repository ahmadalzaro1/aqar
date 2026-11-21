/**
 * Deterministic call policy — the rules a call must satisfy before it is even
 * worth asking a human. Pure: no clock, no I/O, no model.
 *
 * This is deliberately a *predicate over the call's own fields* (action, the
 * argument values, the caller's role) rather than prose handed to a model. A
 * prompt cannot talk these rules out of a limit, which is the whole point: the
 * model decides *what* to propose, this decides whether the proposal is even
 * admissible, and a human decides whether it happens.
 *
 * Precedence: deny > approve_required > allow. One failing rule is enough to
 * deny; nothing can be "allowed by accumulation".
 */

export type PolicyVerdict = 'allow' | 'approve_required' | 'deny';

export interface PolicyLimits {
  /** Roles that may authorise a consequential action at all. */
  readonly approverRoles: readonly string[];
  /** Highest vendor dispatch NTE that policy permits, in fils. */
  readonly nteCeilingFils: number;
  /**
   * Calls at or below this amount may execute without a human. Zero means
   * nothing auto-executes — the shipped default, because the safe default for
   * money is "someone looked at it".
   */
  readonly autoApproveUnderFils: number;
  /**
   * How long after execution an undo is still a correction rather than a
   * re-opening of a closed period. Beyond it the reversal is refused by rule and
   * the operator is pointed at a journal entry instead.
   */
  readonly reversalWindowHours: number;
  /**
   * Amount above which a second, *distinct* signature is required, in fils.
   * `null` means no dual control is configured — stated explicitly rather than
   * implied by a number nobody remembers setting.
   */
  readonly dualControlAboveFils: number | null;
  /** Distinct approvers required once the dual-control threshold is crossed. */
  readonly requiredApprovers: number;
}

export const DEFAULT_POLICY_LIMITS: PolicyLimits = Object.freeze({
  approverRoles: Object.freeze(['owner_admin', 'accountant', 'property_manager']),
  nteCeilingFils: 500_000,
  autoApproveUnderFils: 0,
  reversalWindowHours: 720,
  dualControlAboveFils: 400_000,
  requiredApprovers: 2,
});

export interface PolicyRule {
  readonly rule: string;
  readonly verdict: PolicyVerdict;
  readonly detail: string;
}

export interface PolicyInput {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly role: string;
  readonly limits?: PolicyLimits;
}

export interface PolicyDecision {
  readonly verdict: PolicyVerdict;
  /** Every rule that ran, in evaluation order — the audit trail for a refusal. */
  readonly rules: readonly PolicyRule[];
  /** The rules that produced the final verdict. */
  readonly decisive: readonly PolicyRule[];
}

const PAYMENT_METHODS = ['cash', 'cliq', 'bank_transfer', 'cheque'] as const;

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function allocatedTotal(args: Readonly<Record<string, unknown>>): number | null {
  const raw = args['allocations'];
  if (raw === undefined || raw === null) return 0;
  if (!Array.isArray(raw)) return null;
  let total = 0;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const amount = (entry as Record<string, unknown>)['amountFils'];
    if (!isPositiveInt(amount)) return null;
    total += amount;
  }
  return total;
}

function shapeRules(action: string, args: Readonly<Record<string, unknown>>): PolicyRule[] {
  const rules: PolicyRule[] = [];
  const need = (key: string, ok: (v: unknown) => boolean, what: string): void => {
    rules.push(args[key] !== undefined && ok(args[key])
      ? { rule: `args.${key}`, verdict: 'allow', detail: `${key} is a valid ${what}` }
      : { rule: `args.${key}`, verdict: 'deny', detail: `${key} must be a ${what}` });
  };

  if (action === 'post_payment') {
    need('leaseId', isNonEmptyString, 'lease id');
    need('amountFils', isPositiveInt, 'positive integer fils');
    need('receivedDate', isIsoDate, 'ISO date');
    need('method', (v) => isNonEmptyString(v) && (PAYMENT_METHODS as readonly string[]).includes(v), 'known payment method');
    const amount = args['amountFils'];
    const allocated = allocatedTotal(args);
    if (allocated === null) {
      rules.push({ rule: 'args.allocations', verdict: 'deny', detail: 'allocations must be a list of {chargeId, amountFils}' });
    } else {
      rules.push(
        isPositiveInt(amount) && allocated > amount
          ? { rule: 'args.allocations', verdict: 'deny', detail: `allocations total ${allocated} exceeds the receipt ${amount}` }
          : { rule: 'args.allocations', verdict: 'allow', detail: allocated === 0 ? 'no allocations' : `allocations total ${allocated}` },
      );
    }
  }

  if (action === 'dispatch_vendor') {
    need('ticketId', isNonEmptyString, 'ticket id');
    need('vendorId', isNonEmptyString, 'vendor id');
    const nte = args['amountFils'];
    rules.push(nte === undefined || nte === null
      ? { rule: 'args.amountFils', verdict: 'allow', detail: 'no NTE set' }
      : isPositiveInt(nte)
        ? { rule: 'args.amountFils', verdict: 'allow', detail: `NTE ${nte} fils` }
        : { rule: 'args.amountFils', verdict: 'deny', detail: 'NTE must be a positive integer in fils' });
  }

  return rules;
}

/**
 * Evaluate one call against the limits. Order of rules is stable so a refusal's
 * audit record is diffable across runs.
 */
export function evaluateProposal(input: PolicyInput): PolicyDecision {
  const limits = input.limits ?? DEFAULT_POLICY_LIMITS;
  const rules: PolicyRule[] = [];

  const known = input.action === 'post_payment' || input.action === 'dispatch_vendor';
  rules.push(known
    ? { rule: 'action.known', verdict: 'allow', detail: `${input.action} has a policy` }
    : { rule: 'action.known', verdict: 'deny', detail: `no policy exists for action "${input.action}"` });

  const roleOk = limits.approverRoles.includes(input.role);
  rules.push(roleOk
    ? { rule: 'role.approver', verdict: 'allow', detail: `${input.role} may approve` }
    : { rule: 'role.approver', verdict: 'deny', detail: `${input.role} is not an approver` });

  rules.push(...shapeRules(input.action, input.args));

  if (input.action === 'dispatch_vendor') {
    // Binding a vendor to a job is consequential whether or not a ceiling was
    // named, so it always needs a human — the NTE check only decides how much.
    rules.push({ rule: 'limit.dispatch_human', verdict: 'approve_required', detail: 'dispatching a vendor always needs a human' });
    const nte = input.args['amountFils'];
    if (isPositiveInt(nte) && nte > limits.nteCeilingFils) {
      rules.push({
        rule: 'limit.nte_ceiling',
        verdict: 'deny',
        detail: `${nte} fils exceeds the ${limits.nteCeilingFils} fils dispatch ceiling`,
      });
    }
  }

  const amount = input.args['amountFils'];
  if (isPositiveInt(amount)) {
    rules.push(amount <= limits.autoApproveUnderFils
      ? { rule: 'limit.auto_approve', verdict: 'allow', detail: `${amount} fils is under the auto-approve threshold` }
      : { rule: 'limit.auto_approve', verdict: 'approve_required', detail: `${amount} fils needs a human` });
  }

  const denied = rules.filter((r) => r.verdict === 'deny');
  const needHuman = rules.filter((r) => r.verdict === 'approve_required');
  const verdict: PolicyVerdict = denied.length > 0 ? 'deny' : needHuman.length > 0 ? 'approve_required' : 'allow';

  return Object.freeze({
    verdict,
    rules: Object.freeze(rules),
    decisive: Object.freeze(verdict === 'deny' ? denied : verdict === 'approve_required' ? needHuman : []),
  });
}
