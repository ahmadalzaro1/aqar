/**
 * The compiled form of the policy.
 *
 * `evaluateProposal` answers "may this call happen?" and is deliberately a
 * predicate over the call's own fields. This module adds the two things that
 * make a decision *auditable* rather than merely repeatable:
 *
 *   1. **The limits are closed over.** `compilePolicy(limits)` returns a
 *      `decide` that takes no limit argument, so no call site can quietly pass a
 *      different ceiling — the only way to get a different answer is to compile a
 *      different policy, and that produces a different `version`.
 *   2. **The policy names itself.** `version` is a content hash of the normalised
 *      limits; it is stamped on the audit record beside the deciding rules, so
 *      "which policy said yes" survives an edit to the numbers.
 *
 * Borrowed from Cedar: default deny, forbid overrides (a satisfied deny can
 * never be outvoted by allows — the verdict is computed, not accumulated), and
 * diagnostics that name the *determining* rules rather than a bare boolean.
 * Borrowed from OPA partial evaluation: what is known at compile time is baked
 * into the residual predicate, and the decision log carries the revision.
 *
 * Pure: no clock, no I/O, no randomness. Two calls with the same facts produce
 * byte-identical decisions — that is what makes a stored decision replayable.
 */

import type { PolicyDecision, PolicyLimits, PolicyRule, PolicyVerdict } from './limits.js';
import { DEFAULT_POLICY_LIMITS, evaluateProposal } from './limits.js';

/** Actions this codebase knows how to undo. Must cover every reverser in the web app. */
export const REVERSIBLE_ACTIONS: readonly string[] = Object.freeze(['post_payment', 'dispatch_vendor']);

/** Who filed the proposal, when that is a human. An agent has no duty to separate from. */
export interface Requester {
  readonly kind: 'human' | 'agent';
  readonly userId?: string;
}

export interface ProposalFacts {
  readonly kind: 'proposal';
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly role: string;
  /** The principal acting now — the approver. Absent for a dry run. */
  readonly actorId?: string;
  readonly requester?: Requester;
  /** Distinct approvers already recorded for this proposal, oldest first. */
  readonly approvals?: readonly { readonly userId: string }[];
}

export interface ReversalFacts {
  readonly kind: 'reversal';
  readonly action: string;
  readonly role: string;
  /** The principal acting now — the reverser. */
  readonly actorId: string;
  /** When the execution being undone was recorded (ISO 8601). */
  readonly executedAt: string;
  /** Now, as an explicit input: this module never reads a clock. */
  readonly now: string;
}

export type PolicyFacts = ProposalFacts | ReversalFacts;

/** What a decision looks like on an audit row: the policy, the verdict, the reasons. */
export interface PolicyRecord {
  readonly version: string;
  readonly verdict: PolicyVerdict;
  /** The rules that produced the verdict. Empty for `allow` — nothing vetoed. */
  readonly decisive: readonly { readonly rule: string; readonly detail: string }[];
  /**
   * Every rule that ran, by id. `decisive` answers "why was it refused", which is
   * empty when nothing was; this answers "what was considered", which is what a
   * replay needs.
   */
  readonly rules: readonly string[];
}

export interface CompiledPolicy {
  /** Content hash of the normalised limits. Goes on every decision record. */
  readonly version: string;
  readonly limits: PolicyLimits;
  readonly decide: (facts: PolicyFacts) => PolicyDecision;
  /** The decision as it should be stored — version included, so it can be replayed. */
  readonly record: (decision: PolicyDecision) => PolicyRecord;
}

const HOUR_MS = 3_600_000;

/**
 * Stable stringify: sorted keys, no whitespace. `JSON.stringify` preserves
 * insertion order, so the same limits written in a different order would hash
 * differently and a replay would look like a policy change.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** cyrb53 — a small, dependency-free 53-bit hash. Core must not import node:crypto. */
function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return `${hex(h2)}${hex(h1)}`;
}

/** The version is derived, never hand-written — it cannot drift from the numbers. */
export function policyVersion(limits: PolicyLimits): string {
  return cyrb53(stableStringify(limits)).slice(0, 12);
}

function combine(rules: readonly PolicyRule[]): PolicyDecision {
  const denied = rules.filter((r) => r.verdict === 'deny');
  const needHuman = rules.filter((r) => r.verdict === 'approve_required');
  // Forbid overrides: a satisfied deny wins outright; nothing accumulates past it.
  const verdict: PolicyVerdict = denied.length > 0 ? 'deny' : needHuman.length > 0 ? 'approve_required' : 'allow';
  const decisive = verdict === 'deny' ? denied : verdict === 'approve_required' ? needHuman : [];
  return Object.freeze({ verdict, rules: Object.freeze(rules), decisive: Object.freeze(decisive) });
}

function decideProposal(facts: ProposalFacts, limits: PolicyLimits): PolicyDecision {
  // The shape/authority/limit rules are the existing predicate's job; this adds
  // the rules that need facts a bare call does not carry (who filed it, who has
  // already signed) and then applies the same precedence.
  const base = evaluateProposal({ action: facts.action, args: facts.args, role: facts.role, limits });
  const extra: PolicyRule[] = [];

  if (facts.actorId !== undefined && facts.requester !== undefined && facts.requester.kind === 'human' && facts.requester.userId === facts.actorId) {
    extra.push({
      rule: 'sod.requester_not_approver',
      verdict: 'deny',
      detail: 'the person who filed this proposal cannot be the person who approves it',
    });
  } else if (facts.requester !== undefined) {
    extra.push({
      rule: 'sod.requester_not_approver',
      verdict: 'allow',
      detail: facts.requester.kind === 'agent' ? 'filed by an agent — no human duty to separate from' : 'approver is not the filer',
    });
  }

  // Dual control is configuration, not a rule: at `null` there is no threshold
  // above which a second signature is required, and saying so is more honest
  // than silently requiring one signature everywhere.
  const amount = facts.args['amountFils'];
  const approvals = facts.approvals?.length ?? 0;
  if (limits.dualControlAboveFils === null) {
    extra.push({ rule: 'concurrence.dual_control', verdict: 'allow', detail: 'no dual-control threshold configured' });
  } else if (typeof amount === 'number' && Number.isInteger(amount) && amount > limits.dualControlAboveFils) {
    const enough = approvals >= limits.requiredApprovers;
    extra.push({
      rule: 'concurrence.distinct_approvers',
      verdict: enough ? 'allow' : 'approve_required',
      detail: enough
        ? `${approvals} distinct approvers recorded`
        : `${amount} fils exceeds the ${limits.dualControlAboveFils} fils dual-control threshold and needs ${limits.requiredApprovers} distinct approvers, ${approvals} recorded`,
    });
  }

  return combine([...base.rules, ...extra]);
}

function decideReversal(facts: ReversalFacts, limits: PolicyLimits): PolicyDecision {
  const rules: PolicyRule[] = [];

  rules.push(REVERSIBLE_ACTIONS.includes(facts.action)
    ? { rule: 'reversal.action_known', verdict: 'allow', detail: `${facts.action} can be undone` }
    : { rule: 'reversal.action_known', verdict: 'deny', detail: `no reversal exists for action "${facts.action}"` });

  rules.push(limits.approverRoles.includes(facts.role)
    ? { rule: 'role.approver', verdict: 'allow', detail: `${facts.role} may reverse` }
    : { rule: 'role.approver', verdict: 'deny', detail: `${facts.role} is not an approver, so it cannot undo one` });

  const executedAt = Date.parse(facts.executedAt);
  const now = Date.parse(facts.now);
  if (Number.isNaN(executedAt) || Number.isNaN(now)) {
    rules.push({ rule: 'reversal.window', verdict: 'deny', detail: 'executedAt and now must both be ISO 8601 timestamps' });
  } else {
    const ageHours = (now - executedAt) / HOUR_MS;
    rules.push(ageHours <= limits.reversalWindowHours
      ? { rule: 'reversal.window', verdict: 'allow', detail: `${ageHours.toFixed(1)}h after execution, inside the ${limits.reversalWindowHours}h window` }
      : { rule: 'reversal.window', verdict: 'deny', detail: `${ageHours.toFixed(1)}h after execution is outside the ${limits.reversalWindowHours}h window — correct it with a journal entry instead` });
  }

  // Deliberately allowed: the accountant who misposted is usually the one who
  // catches it. The control is the mandatory stored reason, not a prohibition.
  rules.push({
    rule: 'reversal.self_correction',
    verdict: 'allow',
    detail: 'the reverser may be the person who executed it; the stored reason is the control',
  });

  return combine(rules);
}

/**
 * A refusal that carries its own evidence. Routes map this to 403 and can put
 * the deciding rules in the response, instead of matching on message text.
 */
export class PolicyDeniedError extends Error {
  readonly decision: PolicyDecision;
  /** The compiled policy's version, so a 403 can name the rules *and* the policy. */
  readonly version: string;
  constructor(scope: string, decision: PolicyDecision, version: string) {
    super(`policy denied ${scope}: ${decision.decisive.map((r) => `${r.rule} (${r.detail})`).join('; ')}`);
    this.name = 'PolicyDeniedError';
    this.decision = decision;
    this.version = version;
  }
}

/**
 * Compile the limits into a decision function. The returned `decide` is total
 * (always one of three verdicts) and deterministic (no clock, no I/O, no
 * randomness), which is what allows a stored decision to be replayed.
 */
export function compilePolicy(limits: PolicyLimits = DEFAULT_POLICY_LIMITS): CompiledPolicy {
  const frozen: PolicyLimits = Object.freeze({
    ...limits,
    approverRoles: Object.freeze([...limits.approverRoles]),
  });
  const version = policyVersion(frozen);
  return Object.freeze({
    version,
    limits: frozen,
    decide: (facts: PolicyFacts): PolicyDecision =>
      facts.kind === 'reversal' ? decideReversal(facts, frozen) : decideProposal(facts, frozen),
    record: (decision: PolicyDecision): PolicyRecord => ({
      version,
      verdict: decision.verdict,
      decisive: decision.decisive.map((r) => ({ rule: r.rule, detail: r.detail })),
      rules: decision.rules.map((r) => r.rule),
    }),
  });
}
