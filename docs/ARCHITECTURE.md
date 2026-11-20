# Aqar — Architecture

Aqar is a **money-and-obligation ledger with an operations queue attached**.
Not a CRM, not a listings site. Three laws override every feature decision.

## The two paths

```
MONEY PATH (deterministic, audited, reversible)
  bank CSV / CAMT.053 ──► import wizard (human confirms mapping)
  tenant payment ───────► packages/core (PURE integer-fils math)
                            charges · allocation waterfall · aging
                            late fees · journal · reversals · locks
                          ──► packages/db (Postgres 16, RLS, guards)
                          ──► apps/web (renders core output, never recomputes)

AGENT PATH (drafts, proposes, never moves money alone)
  WhatsApp / Telegram / email / in-app
    ──► apps/channels (signature-verified webhooks)
    ──► apps/worker (BullMQ queues)
    ──► packages/agents orchestrator (typed sequential pipeline)
          EmergencyPrecheck (DETERMINISTIC, no LLM)
            ──OR-merge──► Classifier (local model, cost-routed)
          Enricher (local ONNX embeddings ──► pgvector similarity)
          Troubleshooter (max 3 rounds) ──► Responsibility
          VendorMatcher ──► ApprovalGate (core policy engine)
          Dispatcher ──► FollowUp ──► Closer
    ──► every step: zod-validated, traced, attributed, undoable
```

**The contract between the paths:** agents may *describe* numbers produced by
`packages/core`; they may never *produce* them. A model output can raise
severity, never lower an emergency flag (LAW 2). Every agent mutation carries
an audit event with before/after diff and a one-click reversal (LAW 3).

## Packages

| Package | Role | I/O allowed |
|---|---|---|
| `packages/core` | pure domain: money, leases, ops, policy, metrics | **NONE** (CI-enforced) |
| `packages/contracts` | zod schemas for entities, events, tool I/O | none |
| `packages/db` | Drizzle schema, migrations up+down, RLS, guards, seed | Postgres |
| `packages/agents` | typed agents, orchestrator, providers, tool registry | model endpoints |
| `packages/ui` | tokens, primitives, RTL utilities | none |
| `packages/evals` | golden fixtures + scoring harness | local model |
| `apps/web` | Next.js 15 console (App Router, React 19, Tailwind v4) | DB via server |
| `apps/worker` | BullMQ queues, schedulers, agent runs | Redis, DB |
| `apps/channels` | Hono webhook handlers (WhatsApp, Telegram, email) | channel APIs |

## Model providers

OpenAI-compatible client, two endpoints: `LOCAL_BASE_URL` (default
`http://127.0.0.1:8002/v1`, local oMLX/llama-server) and `CLOUD_BASE_URL`
(optional, **disabled by default**). Embeddings are local ONNX
(multilingual-e5-small, 384 dims) into pgvector — no cloud embedding calls.
Cost routing: local/cheap by default; escalate only when confidence is below
0.7, severity is High or above, or schema validation failed once. Per-ticket
token budget; over budget means human handoff, never silent truncation.

## Tenancy and safety belts

1. Every query scoped by `organization_id` in the application layer.
2. Postgres row-level security (FORCE) as the second belt; the app connects
   as non-superuser `aqar_app` with `app.organization_id` set per connection.
3. Append-only audit log enforced by a database trigger (UPDATE/DELETE raise).
4. Journal balance and period-lock enforced by database triggers *and* core.

## Enforcement

- LAW 1: `scripts/check-core-deps.mjs` scans core source for forbidden
  imports/calls and allowlists runtime deps; runs in CI and locally.
- LAW 2: `mergeClassification` in `packages/core/src/ops` plus adversarial
  eval suite `emergency-adversarial` (threshold 100%).
- LAW 3: `audit_events` append-only trigger + reversal-only corrections +
  UI undo on every agent-originated mutation.

## The proactive path

An agent that acts unprompted is a different risk from one that answers: the
failure mode is not being wrong, it is being *unignorable*. So the proactive
engine is three separately-testable steps, never one function, and it can be
re-run at any frequency without changing the outcome.

```
        fact committed                  published            delivered
   ┌──────────────┐   ┌──────────┐   ┌───────────────┐   ┌────────────┐
   │   scan       │──▶│  outbox  │──▶│    intents    │──▶│  dispatch  │
   │ (same tx as  │   │ (promise)│   │ (dedupe key,  │   │ (policy +  │
   │  the fact)   │   │          │   │  tier, state) │   │  budget)   │
   └──────────────┘   └──────────┘   └───────────────┘   └────────────┘
```

| Step | Where | Contract |
|---|---|---|
| `scanTriggers` | `apps/worker/src/notifications.ts` | writes `outbox` rows in the same transaction as the fact; `ON CONFLICT DO NOTHING` on a **semantic** dedupe key |
| `relayOutbox` | same | one unpublished row → one intent, in one transaction; digests coalesce |
| `dispatchPending` | same | pure policy decides; the ledger records sends **and suppressions** |
| `expireUnanswered` | same | terminal state, so the queue cannot grow forever |
| cycle | `apps/worker/src/proactive.ts` | 15-minute repeatable + a 06:30 digest run, `upsertJobScheduler` (idempotent on restart) |

**Tiers** (`packages/core/src/ops/interruption.ts`, pure, unit- and
property-tested): T0 safety, T1 money/legal, T2 operational, T3 ambient. Only T0
bypasses quiet hours. The policy returns a decision object, never a boolean, so
`{action:'suppress', reason:'daily_budget'}` is a measurement instead of silence.

**Digests.** Twenty-one overdue charges at one T1 message a day is not
"quiet" — it is three weeks of silence for whoever is at the back of the queue.
`rent_overdue` and `ticket_sla_breach` coalesce into one message per day, which
keeps counting while it is undelivered. Safety is deliberately excluded: an
emergency ticket's SLA breach is reclassified to `emergency_unacknowledged`
(T0, its own acknowledgement) by the deterministic `emergency_flag`, never
folded into a batch.

**Cadence.** Dedupe keys carry a bucket — `:w3` (weeks late) for rent, `:d2`
(days open) for tickets — so a fact that nobody acted on comes back on a
schedule instead of going quiet after one notification.

**Clock.** The engine takes `now` as an argument and stamps `notification_sends`
with that same instant. Reading the wall clock in the decision and `now()` in
the ledger silently desynchronises the budget from the sends: found by a test
that injected a future time, which is the only reason the budget assertions
could fail at all.
