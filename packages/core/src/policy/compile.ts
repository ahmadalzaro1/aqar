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
 *      limits *and* of what the rules do — the rule catalogue plus a behaviour
 *      fingerprint over a fixed battery of probes. It is stamped on the audit
 *      record beside the deciding rules, so "which policy said yes" survives an
 *      edit to the numbers **and** to the predicate. A limits-only hash was not
 *      enough: change a comparison, add a forbid, and the old stamp would still
 *      claim the decision came from a policy that no longer exists.
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

/**
 * Every rule id the predicate can emit, in the order a reader should meet them.
 *
 * The catalogue exists because the version has to change when the *rules* change,
 * not only when the numbers do. Families whose id is built from a field name
 * (`args.leaseId`, `args.amountFils`, …) are declared once as `args.*`, and the
 * completeness test refuses any observed id that neither matches a catalogue entry
 * exactly nor falls inside a declared family — so a new rule cannot be added
 * without registering it, and a registered rule cannot be left dead.
 */
export const RULE_CATALOGUE: readonly string[] = Object.freeze([
  'action.known',
  'role.approver',
  'args.*',
  'limit.auto_approve',
  'limit.nte_ceiling',
  'limit.dispatch_human',
  'sod.requester_not_approver',
  'concurrence.dual_control',
  'concurrence.distinct_approvers',
  'reversal.action_known',
  'reversal.window',
  'reversal.self_correction',
]);

/** Does an observed rule id belong to the declared catalogue? */
export function cataloguedRule(id: string): boolean {
  return RULE_CATALOGUE.some((entry) =>
    entry.endsWith('.*') ? id.startsWith(entry.slice(0, -1)) : entry === id,
  );
}

/**
 * A fixed battery of probes, run against the compiled predicate, whose verdicts
 * and rule ids are hashed into the version.
 *
 * Why behaviour and not just the catalogue: a rule can keep its id while its
 * condition changes (`>` to `>=`, a ceiling read from the wrong field, a forbid
 * that stops applying). The catalogue would not notice; the probe that sits on
 * the threshold does. Deliberately built from arguments that need no database, so
 * the fingerprint is a pure function of the policy.
 */
function probes(limits: PolicyLimits): readonly PolicyFacts[] {
  const lease = '00000000-0000-4000-8000-000000000001';
  const base = { leaseId: lease, receivedDate: '2026-01-01', reference: 'P', note: null };
  const at = '2026-06-01T00:00:00.000Z';
  const executedAt = '2026-05-01T00:00:00.000Z';
  const threshold = limits.dualControlAboveFils;
  return Object.freeze([
    { kind: 'proposal', action: 'unheard_of', args: {}, role: 'accountant' },
    { kind: 'proposal', action: 'post_payment', args: { ...base, amountFils: 100_000, method: 'cliq' }, role: 'accountant' },
    { kind: 'proposal', action: 'post_payment', args: { ...base, amountFils: 100_000, method: 'cheque' }, role: 'accountant' },
    { kind: 'proposal', action: 'post_payment', args: { ...base, amountFils: 100_000, method: 'cheque', chequeStatus: 'deposited' }, role: 'accountant' },
    { kind: 'proposal', action: 'post_payment', args: { ...base, amountFils: 100_000, method: 'cash', allocations: [{ chargeId: 'c', amountFils: 200_000 }] }, role: 'accountant' },
    { kind: 'proposal', action: 'post_payment', args: { ...base, amountFils: limits.nteCeilingFils + 1, method: 'cash' }, role: 'accountant' },
    // On the dual-control band, with and without the second key: this is the pair
    // that catches a threshold comparison changing direction or inclusivity.
    ...(threshold === null ? [] : [
      { kind: 'proposal' as const, action: 'post_payment', args: { ...base, amountFils: threshold + 1, method: 'cash' }, role: 'accountant', actorId: 'u-1', approvals: [] },
      { kind: 'proposal' as const, action: 'post_payment', args: { ...base, amountFils: threshold + 1, method: 'cash' }, role: 'accountant', actorId: 'u-1', approvals: [{ userId: 'u-2' }, { userId: 'u-3' }] },
      { kind: 'proposal' as const, action: 'post_payment', args: { ...base, amountFils: threshold, method: 'cash' }, role: 'accountant', actorId: 'u-1', approvals: [] },
    ]),
    { kind: 'proposal', action: 'dispatch_vendor', args: { ticketId: 't', vendorId: 'v' }, role: 'property_manager', actorId: 'u-1', requester: { kind: 'human', userId: 'u-1' } },
    { kind: 'proposal', action: 'dispatch_vendor', args: { ticketId: 't', vendorId: 'v' }, role: 'property_manager', actorId: 'u-1', requester: { kind: 'agent' } },
    { kind: 'reversal', action: 'post_payment', role: 'accountant', actorId: 'u-1', executedAt, now: at },
    { kind: 'reversal', action: 'post_payment', role: 'accountant', actorId: 'u-1', executedAt: '2025-01-01T00:00:00.000Z', now: at },
    { kind: 'reversal', action: 'post_payment', role: 'viewer', actorId: 'u-1', executedAt, now: at },
    { kind: 'reversal', action: 'unheard_of', role: 'accountant', actorId: 'u-1', executedAt, now: at },
  ]);
}

/** hash(verdict, rule ids) over every probe — details are wording, not policy. */
function behaviourFingerprint(limits: PolicyLimits, decide: (facts: PolicyFacts) => PolicyDecision): string {
  const observed = probes(limits).map((facts) => {
    const decision = decide(facts);
    return `${decision.verdict}|${decision.rules.map((r) => r.rule).join(',')}`;
  });
  return cyrb53(observed.join('\n'));
}

/** The sentinel for a caller that has not measured behaviour (tests, tooling). */
const BEHAVIOUR_UNMEASURED = 'unmeasured';

/**
 * The version is derived, never hand-written, and it covers everything that can
 * change an answer: the numbers, the rule vocabulary, and what the rules do.
 *
 * `behaviour` defaults to a sentinel so a direct caller cannot accidentally claim
 * the identity of a compiled policy — `compilePolicy` always passes the measured
 * fingerprint.
 */
export function policyVersion(limits: PolicyLimits, behaviour: string = BEHAVIOUR_UNMEASURED): string {
  return cyrb53(stableStringify({ limits, rules: RULE_CATALOGUE, behaviour })).slice(0, 12);
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
    policyEditorRoles: Object.freeze([...limits.policyEditorRoles]),
  });
  // Decide first, then fingerprint: the version names what the predicate *does*,
  // so a logic change cannot hide behind an unchanged set of numbers.
  const decide = (facts: PolicyFacts): PolicyDecision =>
    facts.kind === 'reversal' ? decideReversal(facts, frozen) : decideProposal(facts, frozen);
  const version = policyVersion(frozen, behaviourFingerprint(frozen, decide));
  return Object.freeze({
    version,
    limits: frozen,
    decide,
    record: (decision: PolicyDecision): PolicyRecord => ({
      version,
      verdict: decision.verdict,
      decisive: decision.decisive.map((r) => ({ rule: r.rule, detail: r.detail })),
      rules: decision.rules.map((r) => r.rule),
    }),
  });
}
