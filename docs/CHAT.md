# The chat surface — one panel, every provider, human-gated execution

Status: **building** — S0 landed, S1 landed, S2 landed, S3 backend landed (inbox UI in progress). Owner: agent-ops.
Supersedes nothing; extends D15 ("MCP first, in-app chat second") — MCP is done,
this is the second half.

## What was already researched, and still holds

| Finding | Source | Consequence for this build |
| --- | --- | --- |
| The module is a **provider abstraction**, not a local model: `LOCAL_BASE_URL` + `CLOUD_BASE_URL`, `CLOUD_API_KEY`, `costPerMillion`, `estimatedCostUsd` per call, cloud `null` until configured | `packages/agents/src/provider.ts` | Any OpenAI-compatible endpoint — local `lfm3`, Nous free tier, OpenRouter, OpenAI. No code change to switch. Cost is already measured, so a per-turn cost meter is free. |
| **Streaming chat history is client-controlled** — a crafted approval can bypass the in-UI human step | `docs/AGENTS.md` §Next layer (2026-11-20) | Transcript lives server-side; approvals are HMAC-signed at issuance over (userId, tool, toolCallId, canonical input, expiry) and **revalidated against current DB state at apply**. Never trust the client's rendering of "approved". |
| Money is proposal-only; agents draft, humans approve | `docs/DECISIONS.md` D15, `apps/mcp/src/gate.ts` | The panel can *raise* a proposal; it cannot post a payment. An MCP caller has no approval channel — a signed-in human does. |
| Service replies are metered (WhatsApp), one good reply beats a conversation | `docs/AGENTS.md` §Next layer | The panel is for operators, not tenants. Tenant conversation stays in the ticket thread. |

## The gap this closes

- `packages/agents` has 27 tool **definitions** and no handlers.
- `apps/mcp` has 18 working tools, but their logic is welded inside
  `server.registerTool(...)` closures — the web app cannot call them.
- `action_proposals` has rows and nothing in the console that can act on them
  (`BLOCKERS.md:199`: *human chat surface, approvals inbox, proposal executor*).
- `provider.chat()` has no `tools` field and its response schema demands
  `content: string`, so a tool-calling reply (`content: null`) is rejected as
  malformed. **The module can talk; it structurally cannot act.**

## Slices

### S0 — provider speaks tools (this slice)
Add `tools`/`tool_choice` to the request; accept `content: null` + `tool_calls[]`
in the schema; surface `toolCalls[]` and `finishReason` on the response; keep the
text-only path byte-compatible for existing callers.

Acceptance: a real tool call round-trips through **our** provider to
`lfm3-local`; a completion with neither content nor tool calls is a `schema`
error, not a silent empty answer; the wire message shape is asserted in a test.

**Landed.** `packages/agents` tsc exit 0; vitest 26 passed / 2 skipped (two new
tool-call tests). Live probe against `http://127.0.0.1:11434/v1` (`lfm3-local`,
two tools offered): `finishReason: "tool_calls"`, `latencyMs: 1154`,
`toolCalls: [{ name: "list_vacant_units", argumentsJson: "{}" }]`, tokens
144/14/158. The wire type is `ModelTool` (not `ToolSpec`, which `tools.ts`
already owns as the policy entry).

### S1 — one tool core, two adapters
`packages/tools`: `runTool(name, args, ctx) → plain data`, with the SQL moved out
of the MCP closures file by file. `apps/mcp` keeps its 18 registrations as thin
wrappers; `apps/web` calls the same core in-process.

Acceptance after each file: MCP integration tests unchanged and green; tool output
identical (same keys, same money formatting).

### S2 — the panel
`ChatDock` mounted once in `apps/web/src/components/Shell.tsx`, so it is present
on every `(console)` route and survives navigation. ⌘J toggles; 380 px rail
>1200 px, drawer 900–1200, bottom sheet <900. Provider selector (local/strong) and
per-turn cost in the header. Read tools only.

Acceptance: ask on `/tickets/[id]`, navigate to `/ledger`, ask again — same
thread, both answers, no remount.

**Landed.** `/api/chat` (session-scoped, read tools only) + `ChatDock` in
`Shell.tsx`. `next build --webpack` exit 0 with `/api/chat` in the route table.
Measured through the real UI with a minted session:

| Question | Tool | Answer | Wall |
| --- | --- | --- | --- |
| "How many units are vacant, and total arrears?" | `portfolio_summary` 15 ms | 4 vacant, **6,807.999 JOD** quoted verbatim | 2.1 s |
| "كم وحدة شاغرة ومن أي عقار؟" | `portfolio_summary` 12 ms | answered in Arabic, 4 vacant | 2.2 s |
| "Which leases expire in the next 30 days?" | `list_expiring_leases` 5 ms | 2 leases, both 2026-11-28, JOD 370.000 / 560.000 | 2.6 s |
| unauthenticated POST | — | 401 | — |

Route change (`/dashboard → /tickets`) keeps the panel open with its thread; a
hard reload restores it from `sessionStorage` (last 20 turns). Not streaming:
the answer only exists after the tool round, so a partial stream would be a lie
about progress — SSE is S2b, driven by the tool trace rather than tokens.

### Known local-runtime failure: withheld completions

The MLX shim on `:11434` refuses a completion whose visible content still holds
thinking delimiters:

```
HTTP 502 — {"error": "Model returned unresolved thinking delimiters in visible
content; response withheld.", "model": "lfm3-local"}
```

Deterministic for some prompts (observed on "What is the email address of the
owner of Abdoun Gardens?" — 3/3 attempts, both rounds). `enable_thinking: false`,
`chat_template_kwargs.enable_thinking`, and `reasoning: false` made **no**
difference. Our provider now appends a 300-char slice of the response body to
`ProviderError` (a bare status cannot distinguish a rejected prefill from an
overloaded server), and the route retries once — which is not enough for the
deterministic case. Real fixes, in order of cost: point `LOCAL_MODEL` at a model
that does not leak delimiters, or configure `CLOUD_BASE_URL` so the turn fails
over instead of dead-ending.

### S3 — approvals

**Backend landed.** The three pieces, and the failure each one closes:

| Piece | Where | What it buys |
| --- | --- | --- |
| Signed claims | `@aqar/approvals` (`token.ts`, `hash.ts`) | "status = approved" says nothing about *what* was approved. The token binds proposal + tool + canonical args hash + expiry + approver into one HMAC; verification returns a distinct reason (`bad_signature`, `expired`, `args_mismatch`, `proposal_mismatch`, `tool_mismatch`). |
| Executor | `apps/web/src/lib/approvals/execute.ts` | The only path from a row to an effect. Re-reads the row `for update`, re-derives the args hash (a row edited after filing is refused), mints and verifies its own token, then runs one registered handler. |
| Decision endpoint | `POST /api/proposals/[id]/decision` | Session-gated, role-gated (`owner_admin`, `accountant`, `property_manager`), `{decision: "approve" \| "reject"}`. |

Handlers are explicit, and so is the absence of one:

- `post_payment` — inserts `payments` for the lease's **primary tenant** (tenants are
  never columns on `leases`; a lease may have several) and optional
  `payment_allocations`, refusing allocations that exceed the receipt.
- `dispatch_vendor` — inserts a `work_orders` row in `dispatched` with the proposal's
  NTE and the approver as `created_by_user_id`.
- anything else — `status = failed`, reason `no executor is registered for action "…"`.
  Nothing is invented, and the row stays visible.

Every decision writes an `audit_events` row with `actor = {kind: "human", userId}`,
plus `decided_by_user_id`, `decided_at` and `result` on the proposal.

Measured against the live database (minted session, real POSTs):

| Case | Result |
| --- | --- |
| approve `post_payment` | 200 in **0.16 s** → payment `4e67c591` 250000 fils `cliq` 2026-11-20, payer `7687f6b4`; proposal `executed`; audit `proposal.executed / human` |
| approve the same proposal again | **409** `proposal is already executed` |
| approve `send_tenant_message` | 200 `status: failed`, `no executor is registered for action "send_tenant_message"` |
| no session cookie | **401** |
| `{"decision":"maybe"}` | **400** |

Hash migration was verified, not assumed: `argsHash` moved from
`apps/mcp/src/ids.ts` to `@aqar/approvals` and re-exported, then **6/6 pending rows
recomputed to their stored `args_hash`**.

One consequence is worth stating plainly, because it is the difference between
correct accounting and a confusing answer: an approved payment is **cash received**,
not arrears relief. `portfolio_summary` now reports all three quantities —
`receivedJod` 39,020.000, `collectedJod` 38,385.000 (applied to charges),
`unallocatedJod` **635.000** — and tells the model to say so. Arrears stay at
6,807.999 after the 250.000 approval because nothing was applied to a charge yet;
the tool now makes that visible instead of leaving a silent discrepancy.

### S3.1 — receipt, spend, and read-back (2026-11-21)

Measured with the same server and a minted session:

| what | result |
|---|---|
| approve a well-formed `post_payment` (250.000 JOD, cliq) | **200**, `confirmed: true`, `readBack {amount_fils: 250000, method: cliq, received_date: 2026-11-20, payer_id: …}` |
| the same proposal after `update … set status='pending'` by hand | **409** `this approval token has already been redeemed` — the `proposal_token_uses` primary key, not the row's status |
| `post_payment` with no `amountFils` at all | **403** `policy denied … args.amountFils (amountFils must be a positive integer fils)` |
| `dispatch_vendor` with a 900.000-fils NTE | **403** `policy denied … limit.nte_ceiling (900000 fils exceeds the 500000 fils dispatch ceiling)`; the row stays `pending`, because a refusal must not consume it |

Three claims are now true that were not:

1. **The token is spent, not merely invalidated.** `proposal_token_uses` has
   `proposal_id` as its primary key and the executor inserts with
   `on conflict do nothing` and refuses when nothing comes back. Single use is a
   database constraint, so it survives anyone resetting a status by hand.
2. **Authorisation now runs against a predicate, not a role string.** `@aqar/core`
   owns `evaluateProposal` — action-known, role-is-approver, argument shape,
   allocation ≤ receipt, NTE ≤ ceiling, and an auto-approve threshold that ships
   at **0**. Pure, property-tested (`limits.test.ts`, 14 tests), and it names the
   rules that stopped a call, which is what the audit record needs.
3. **The write is confirmed, not assumed.** After the transaction commits the
   executor re-selects the row it claims it wrote and stores `confirmed` plus the
   observed values on the proposal. `confirmed: false` is a reachable outcome —
   the row may be gone or different — and it is recorded as
   `proposal.unconfirmed` in the audit log rather than raising.

4. **An executed action can be undone, and the undo is audited too.** A reversal
   is a *void*, never a delete: the payment row keeps its amount and date and
   gains `voided_at` / `void_reason`, so the ledger still answers "what happened"
   while no longer counting it. `proposal_reversals.proposal_id` is a primary
   key, so a reversal is single-use for the same reason an approval is. The
   operator's reason (≥10 characters, enforced in SQL *and* zod) is stored on the
   receipt and on the proposal. Only a `confirmed` execution is reversible —
   reversing one the read-back never saw would manufacture an effect.

   Measured end-to-end on 2026-11-21 (real HTTP against the dev server, real
   Postgres, then a browser click-through):

   | case | result |
   |---|---|
   | approve a `post_payment` | `200`, `status=executed`, `confirmed=true` |
   | reverse it | `200`, `status=reversed`, `reversal.confirmed=true`, `payments.voided_at` set with the operator's reason |
   | audit trail | `proposal.executed` → `proposal.confirmed` → `proposal.reversed` (`reversal_of` = the confirmed event) |
   | reverse it again | `409 this proposal has already been reversed` |
   | reason under 10 characters | `400 body must be {"reason":"<at least 10 characters>"}` |
   | role `maintenance_coordinator` | `403 role maintenance_coordinator cannot reverse consequential actions` |
   | executed but never confirmed | `409 refused: the execution was never confirmed by read-back, so there is no effect to reverse` |
   | no session | `401` |

Still open in S3: bulk approval for the 30-plus-deep queue, and channel traffic
proposing actions end to end.


## Non-negotiables

1. The model never computes money. Tools return `arrearsJod`; the panel quotes
   it. (Measured failure: `lfm3` summed two properties and produced 6808.999
   against a true total of 6807.999 — the exact class of error LAW 1 exists for.)
2. The model never chooses the organization. `ctx.org` is resolved at boot.
3. The chat panel never renders on the public `/` page.
4. Any tool without a handler says so; it does not improvise.
