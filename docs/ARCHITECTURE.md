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
