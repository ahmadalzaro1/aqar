# Policy: one compiled predicate, two keys

> Status: **P1 and P2 landed** (2026-11-21, `compile.ts` + both call sites).
> P3 (dual control) and P4 (per-org limits) remain design. What exists, what
> prior art says, and the smallest path that makes the claim true.

## 1. What the code does today (measured, not remembered)

`@aqar/core` already owns a pure predicate: `evaluateProposal(input)` in
`packages/core/src/policy/limits.ts`. It takes `{ action, args, role, limits }`,
returns `{ verdict, rules, decisive }`, has no clock and no I/O, and its
precedence is deny > approve_required > allow. That is the right shape.

Three things are still wrong:

**1.1 Two paths bypass the predicate.** `apps/web/src/lib/approvals/execute.ts:248`
goes through `evaluateProposal`. The two reversal paths do not:

```ts
// apps/web/src/app/api/proposals/[id]/reversal/route.ts:21
if (!DEFAULT_POLICY_LIMITS.approverRoles.includes(user.role)) { … 403 … }

// apps/web/src/lib/approvals/reverse.ts:120
if (!DEFAULT_POLICY_LIMITS.approverRoles.includes(input.role)) {
  throw new Error(`role ${input.role} cannot reverse consequential actions`);
}
```

This is the exact thing `execute.ts` criticises in its own comment — "not a role
check bolted onto the route". A membership test cannot express "within 24 hours
of execution", "not the person who approved it", or "not above the ceiling".
It also produces no `PolicyDecision`, so a refusal has no named rules to audit —
the 403 says only that a role was not in an array.

**1.2 The limits are a module constant with no version.** `DEFAULT_POLICY_LIMITS`
is frozen in `packages/core` and read from three call sites. The audit record
stores that the action executed, never *under which limits*. Change
`nteCeilingFils` and every historical decision silently changes meaning; nothing
can be replayed.

**1.3 Dual control is structurally impossible.** `action_proposals` has exactly
one approver column (`decided_by_user_id`) and the only separation-of-duties
check is none at all: `requested_by` (jsonb) is never compared to
`decided_by_user_id`. One accountant can approve a 500 JOD dispatch alone. A
"second key" has nowhere to be recorded, so it cannot be required.

## 2. Prior art (primary sources)

**Cedar** (AWS; arXiv 2403.04651, modelled in Lean, properties proved). The
authorizer combines policy evaluations under three rules: any satisfied
`forbid` ⇒ Deny; else any satisfied `permit` ⇒ Allow; else Deny. It returns
diagnostics naming the *determining policies* for the decision. Three properties
it advertises: default deny, forbid overrides permit, skip-on-error.
→ What we borrow: **default deny, forbid-overrides, and determining rules
reported with the verdict** (`PolicyDecision.decisive` is already this).
→ What we do not borrow: the language, the engine, the entity store. A ten-rule
money policy does not justify a Rust engine plus a second DSL in a TypeScript
monorepo, and Cedar's own stated advantage is expressiveness at scale.

**OPA / Rego partial evaluation** (Compile API). A policy is *partially
evaluated* against what is known at compile time, leaving a residual predicate
over the unknowns; the residual — not the source policy — is what ships to the
decision point. OPA decision logs record the bundle revision that produced each
decision.
→ What we borrow: **compile the limits into a closure and stamp its version on
the decision**, so "which policy said yes" is answerable forever. That is the
cheap half of partial evaluation: our unknowns are the call's own fields, and
everything else is known at compile time.

**OpenFGA / Zanzibar** (relationship tuples). Authority derived from a stored
graph — "the property manager *of that building*". The right answer once approval
authority depends on scope rather than a role string. Premature here: we have
one org and four roles.

**Two-person rule / dual-control concurrence.** A control in which no single
actor can complete the operation; the software form is *two distinct
authenticated principals* plus a constraint that survives retries and manual
status resets — i.e. distinctness enforced by the database, not by the handler.
The proposer/approver split (a.k.a. segregation of duties) is the same mechanism
applied to the filing step rather than the authorising step.

## 3. The design

One compiled predicate, one gate, two keys. Three files.

### 3.1 `packages/core/src/policy/compile.ts`

```ts
export interface CallFacts {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly role: string;
  /** Who is acting now: the approver, or the reverser. */
  readonly actorId: string;
  /** Who filed the proposal, when known. */
  readonly requesterId?: string;
  /** Distinct approvers already recorded, most recent last. */
  readonly approvals?: readonly { userId: string; role: string; at: string }[];
  /** Explicit, because "within 24 hours" needs a clock and purity forbids `Date.now`. */
  readonly now: string;
}

export interface CompiledPolicy {
  /** Content hash of the normalised limits — goes on every decision. */
  readonly version: string;
  readonly decide: (facts: CallFacts) => PolicyDecision;
}

export function compilePolicy(limits: PolicyLimits): CompiledPolicy;
```

`version` is `sha256(canonicalJson(limits)).slice(0, 12)`. `decide` is the
existing rule list plus three new rule families, evaluated in a fixed order so
two runs produce byte-identical `rules` arrays (diffable audit records):

| family | rule | verdict |
|---|---|---|
| authority | `role.approver` | deny when the role is not in `approverRoles` |
| authority | `sod.requester_not_approver` | **deny** when `actorId === requesterId` and the amount exceeds `autoApproveUnderFils` |
| limit | `limit.nte_ceiling`, `limit.auto_approve` | as today |
| concurrence | `concurrence.distinct_approvers` | `approve_required` with `detail` naming how many distinct approvers remain |
| reversal | `reversal.window`, `reversal.sod` | deny outside `reversalWindowHours`; deny when the reverser executed it |

### 3.2 Call sites

`execute.ts`, `reverse.ts` and `reversal/route.ts` each replace their
hand-rolled check with `compilePolicy(limits).decide(facts)` and refuse on
`deny`. The route stops carrying policy at all: it parses the body, calls the
service, maps the outcome. No `.includes(` on a role array anywhere.

### 3.3 The second key (schema)

```sql
create table proposal_approvals (
  proposal_id uuid not null references action_proposals(id) on delete cascade,
  approver_id uuid not null references users(id),
  role        text not null,
  approved_at timestamptz not null default now(),
  primary key (proposal_id, approver_id),      -- distinctness, by construction
  check (approver_id is distinct from (null))  -- (illustrative)
);
```

The primary key *is* the two-key invariant: a retry, a double-click or a manual
status reset cannot produce a second approval from the same person. The executor
counts distinct rows inside the same transaction it spends the token in, and
refuses when the count is short — so the count and the spend cannot skew.

`action_proposals.decided_by_user_id` stays as a denormalised "last key" for the
console; the receipt is the table.

## 3.4 What landed, and what it changed

`compilePolicy(limits)` in `packages/core/src/policy/compile.ts` returns
`{ version, limits, decide, record }`. The role-list checks are gone from
`reverse.ts` and the reversal route; `execute.ts` and `reverse.ts` both decide
through the compiled predicate.

Behaviour changes, stated plainly:

- **A reversal older than 720 hours is refused by rule** (`reversal.window`) and
  the refusal tells the operator to use a journal entry. This is a new
  restriction, not a refactor — it is a *limit*, so it moves with the policy and
  its version rather than hiding in code.
- **Dual control is configurable and currently off** (`dualControlAboveFils:
  null`). The rule reports "no dual-control threshold configured" instead of
  pretending the control exists. Turning it on is P3.
- **Separation of duties is implemented but only fires when the requester is
  known** and is a human; agent-filed proposals have no human to separate from.
  Threading `requested_by` into the executor is P3 work.

Measured on the running app, not asserted:

| check | result |
|---|---|
| `@aqar/core` policy suite | 34 tests pass, including **120 differential cases** where the compiled predicate must agree with `evaluateProposal` |
| determinism / totality / forbid-overrides | asserted in `compile.test.ts` |
| coordinator attempts a reversal | `403 policy denied the reversal: role.approver (maintenance_coordinator is not an approver, so it cannot undo one)` + `policy.version`, row unchanged (`executed`, `reversals=0`) |
| approve a fresh payment | `result.policy = {version, verdict: approve_required, rules: [9 ids]}`; `proposal.executed` **and** `proposal.confirmed` audits carry the same stamp |
| reverse it | `policy.rules = [reversal.action_known, role.approver, reversal.window, reversal.self_correction]`, stored on `result.reversal.policy` |
| browser click-through | status block persists after refresh, row flips to `تم التراجع` |

## 4. Order of work

| # | move | why it is this rank |
|---|---|---|
| P1 ✅ | Delete both `.includes()` checks; route reversal through the compiled predicate | Removes the LAW 3 asymmetry and gives refusals named rules. Cheapest, and it is a deletion |
| P2 ✅ | Stamp `policyVersion` + rule ids onto the audit event and `result` | Without it a policy edit rewrites history. Nearly free once P1 exists |
| P3 | `proposal_approvals` + `concurrence`/`sod` rules + executor count check | The actual two-key. Needs a migration and a console affordance ("approved by 1 of 2") |
| P4 | Per-org `policy_limits` row instead of the frozen constant | Only when a second org exists. Versioning (P2) makes this safe to defer |

## 5. Tests the design demands

- **Property test**: for any facts, `decide` is deterministic (same input ⇒
  byte-identical decision) and total (`verdict` is always one of three).
- **Invariant test**: adding a satisfied `forbid`-class rule can never move a
  verdict toward `allow` (Cedar's forbid-overrides, asserted rather than assumed).
- **Differential test**: the compiled predicate agrees with the current
  `evaluateProposal` on every case in `limits.test.ts` — the refactor must not
  change an existing answer.
- **Two-key test**: two approvals from the same `approver_id` violate the
  primary key (assert the *database* refuses, not the handler).
- **Replay test**: a stored decision plus its `policyVersion` resolves to the
  same verdict when the limits are reloaded from that version.
