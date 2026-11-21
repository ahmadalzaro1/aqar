# Policy: one compiled predicate, two keys

> Status: **P1–P4 landed** (2026-11-21). Limits are per organization
> (`policy_limits`), editable through `PUT /api/policy/limits`, and every
> decision carries the version of the policy that made it — a hash of the limits,
> the rule catalogue and the predicate's measured behaviour, so the stamp changes
> when the rules do, not only when the numbers do. What exists, what
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

### P3 — dual control, and the role list that kept coming back

`proposal_approvals` (`0015`) has `primary key (proposal_id, approver_id)`. The
**database**, not the handler, is what makes the second signature distinct.

`DEFAULT_POLICY_LIMITS.dualControlAboveFils` is now **400 000 fils (400 JOD)**,
below the 500 JOD NTE ceiling: ordinary receipts still need one approver, and
anything larger needs two distinct ones. Historical decided proposals were
backfilled with their single recorded approver, so "how many signatures did this
take" stays answerable.

Measured, 450 JOD payment `9ba66e58`:

| step | result |
|---|---|
| accountant signs | `202 {status: awaiting_approval, signatures: 1, required: 2}` — status stays `pending`, **0 payments created** |
| the same accountant signs again | `202 signatures: 1` — the primary key refused the duplicate, not the handler |
| manager signs | `200 executed`, `signatures: 2`, payment `ba3bf355` read back `confirmed: true`, stamps `policy=86c00289dc51` |
| approvers on record | `accountant@aqar.example/accountant, manager@aqar.example/property_manager` |
| console | awaiting row renders `التوقيعات 1 من 2` (server-rendered), still in the queue |

The role list had **five** copies: `limits.approverRoles`, the reversal service,
the reversal route, the decision route and the console page (whose comment
admitted it mirrored the route's). All five now read the compiled policy, so
there is one list and one version.

The executor now carries `requested_by` into the decision, so
`sod.requester_not_approver` fires for anything a human filed: admin filed
`SOD-…` and admin approved it → `403 … sod.requester_not_approver (the person
who filed this proposal cannot be the person who approves it)`, row untouched,
no payment. Agent-filed proposals have no human to separate from, and the rule
shows as `allow` in `rules` so the record says it ran.

The primary-key invariant is now a test, not a demonstration:
`packages/db/src/__tests__/db.integration.test.ts` asserts a second signature
from the same person is refused by Postgres
(`duplicate key value violates unique constraint`), that the count stays 1, that
a distinct second approver makes it 2, that signatures are deleted with the
proposal, and that a signature for a missing proposal violates the foreign key.

### P4 — limits are per organization, and the version proves it

`policy_limits (organization_id pk, limits jsonb, updated_at, updated_by_user_id)`.
No row means `DEFAULT_POLICY_LIMITS` — the numbers are not duplicated in SQL where
they would drift, and the version stays stable for an untouched org.

`loadPolicy(organizationId)` in `apps/web/src/lib/approvals/policy.ts` is the seam:
one query, one **strict** parse, one compiled policy. An unreadable row **refuses
to decide** rather than falling back to the default, because the fallback would
silently widen policy for exactly the organization someone was editing.

**Who may edit** comes from the policy itself (`policyEditorRoles: ['owner_admin']`),
not a sixth role list on a route.

Measured end to end on the live app:

| step | result |
|---|---|
| `GET /api/policy/limits` | `{version: 153259b64a4c, limits: {…, dualControlAboveFils: 400000, …}}` |
| `PUT` as accountant | `403 role accountant cannot edit policy limits (policy 153259b64a4c allows owner_admin)` |
| `PUT` as admin, dual control → 300 JOD | `{version: 44d4070bc3da, previousVersion: 153259b64a4c}` |
| a 350 JOD payment under that policy | `202 {awaiting_approval, signatures 1, required 2}` — *"exceeds the 300000 fils dual-control threshold"*, status `pending`, 0 payments |
| `PUT` back to 400 JOD | version returns to **`153259b64a4c`** — a content hash, so identical limits are identical policy |
| the same 350 JOD proposal, now | `200 executed` with one key, stamped `153259b64a4c` |
| audit | `policy.limits_updated` with `before.version → after.version`, written **in the same transaction** as the limits |

The demo of that last row is also its own bug report: the first attempt wrote the
limits and then failed the audit (`occurred_at` has no default), leaving a change
with no record. Fixed by writing both inside `sql.begin`.

### The stamp named the numbers, not the policy

`policyVersion` hashed the normalised **limits only**. So a rule could change —
a comparison flipped from `>` to `>=`, a forbid that stopped applying, a new rule
added — and the version stayed identical while the answers did not. A decision
stamped `153259b64a4c` before the change and one stamped `153259b64a4c` after it
came from two different predicates, and the audit trail could not tell them apart.
That is the one place where the record was able to lie about *which* policy
decided.

The version now hashes three things: the limits, the **rule catalogue**, and a
**behaviour fingerprint**.

- `RULE_CATALOGUE` lists every rule id the predicate can emit. Field-derived ids
  (`args.leaseId`, `args.amountFils`, …) are declared once as the family `args.*`.
- `behaviourFingerprint` runs a fixed battery of probes — a cheque with no status,
  an amount exactly *on* the dual-control threshold and one fils over it, a
  dispatch filed and approved by the same human, a reversal past its window — and
  hashes the verdict and the rule ids of each answer. Details (wording) are not
  hashed: they are prose, not policy.
- The catalogue catches a rule being added, removed or renamed; the fingerprint
  catches a rule whose *condition* changed while its id stayed. Neither alone is
  enough, which is why both are in the hash.

Two invariants keep the catalogue honest, as tests rather than as care:

| invariant | test | why it matters |
|---|---|---|
| every observed rule id is declared | the battery emits nothing `cataloguedRule()` rejects | a new rule cannot ship unregistered |
| no entry never fires | every catalogue entry (or family) is observed at least once | a renamed rule leaves no dead declaration behind |
| the predicate is part of the name | `compilePolicy(base).version !== policyVersion(base)` | a caller that measured nothing cannot claim a real policy's identity |

Measured live after the change: the same 400 JOD limits that stamped
`153259b64a4c` now stamp **`a2bec4c1fb17`**, and an executed payment records
`policy.version a2bec4c1fb17` beside
`rules: action.known, role.approver, args.leaseId, args.amountFils,
args.receivedDate, args.method, args.allocations, limit.auto_approve,
sod.requester_not_approver`.

Historical stamps are left alone. A row that says `153259b64a4c` was decided by
the limits-only policy of that name; re-deciding it under the current build
produces `a2bec4c1fb17`, and that difference **is** the signal that the predicate
changed — which is exactly what the stamp was for.

What the fingerprint still cannot see: a behaviour change that no probe reaches.
The probes are the specification of what matters, so adding a probe is how you
extend the guarantee. Everything else is covered by the differential suite.

### The cheque that could never succeed

`post_payment` with `method: 'cheque'` used to accept arguments the database
refuses (`payments_cheque_status_ck` needs a status for a cheque and forbids one
otherwise), so the operator discovered it *after* approving, as a 500.

`validateActionArgs(action, args)` in `@aqar/core` is now the argument contract:
pure, no I/O, called by the MCP proposer (refuses to file the draft) and by the
executor (refuses a legacy row). Measured: cheque with no status →
`a cheque payment needs "chequeStatus" to be one of received, deposited, cleared, bounced (got null)`;
cheque with `deposited` → executed, and `payments.cheque_status` reads `deposited`.

## 4. Order of work

| # | move | why it is this rank |
|---|---|---|
| P1 ✅ | Delete both `.includes()` checks; route reversal through the compiled predicate | Removes the LAW 3 asymmetry and gives refusals named rules. Cheapest, and it is a deletion |
| P2 ✅ | Stamp `policyVersion` + rule ids onto the audit event and `result` | Without it a policy edit rewrites history. Nearly free once P1 exists |
| P3 ✅ | `proposal_approvals` + `concurrence` rules + executor count check + console badge | The actual two-key. Migration `0015`; the PK is the control |
| P4 ✅ | Per-org `policy_limits` row, a loader that fails closed, `PUT /api/policy/limits` | A limit change is a row, not a deploy — and the version keeps history honest |

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
