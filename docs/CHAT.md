# The chat surface — one panel, every provider, human-gated execution

Status: **building** — S0 landed, S1 porting, S2 landed, S3 not started. Owner: agent-ops.
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
HMAC approval tokens minted server-side, single-use, bound to the proposal and to
the canonical input; approvals inbox in the panel; executor applies with a
re-read of current DB state; every decision writes `audit_events` and keeps a
reversal handle.

Acceptance: approve a `propose_payment` → proposal `executed`, audit row present,
reversal restores the prior state; replaying the same token is refused.

## Non-negotiables

1. The model never computes money. Tools return `arrearsJod`; the panel quotes
   it. (Measured failure: `lfm3` summed two properties and produced 6808.999
   against a true total of 6807.999 — the exact class of error LAW 1 exists for.)
2. The model never chooses the organization. `ctx.org` is resolved at boot.
3. The chat panel never renders on the public `/` page.
4. Any tool without a handler says so; it does not improvise.
