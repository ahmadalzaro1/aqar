# Agent layer — how Hermes drives Aqar

Aqar exposes its ledger to AI agents over **MCP** (`apps/mcp`, `@aqar/mcp`).
Hermes is the first client; the same server works for Claude, any IDE agent,
or a future in-app assistant.

This document is a contract, not a tour. Two rules govern everything below:

1. **Capability lives in the tool. Restraint lives in the gate.** MCP changes
   *how* tools are delivered, never *which* actions are permitted. There is no
   permission model in MCP — `evaluatePolicy` is the permission model.
2. **The ledger is the truth. Chat is a view.** Nothing an agent says is a
   record. A record is a row with an audit event.

## Registering with Hermes

```bash
hermes mcp add aqar \
  --command ~/HERMES/aqar/apps/mcp/node_modules/.bin/tsx \
  --env DATABASE_URL=... \
        REDIS_URL=redis://127.0.0.1:6380 \
        AQAR_MCP_MODE=propose \
        AQAR_MCP_ACTOR=hermes \
        AQAR_ORG_SLUG=aqar-demo \
  --connect-timeout 60 \
  --args ~/HERMES/aqar/apps/mcp/src/stdio.ts
```

`hermes mcp add` prompts *"Enable all tools?"* — it cancels without a TTY, so
pipe `printf 'y\n' |` in scripts. After adding, run `/reload-mcp` in an open
session or restart the gateway. Verify with a real tool call, never with
"endpoint returned 200".

Diagnostics go to **stderr only**. A stray `console.log` on stdout corrupts the
JSON-RPC stream and presents as a hung server with no error.

## The three-mode ladder

| Mode | Reads | Reversible writes (ticket, promise) | Proposals | Money |
|---|---|---|---|---|
| `read_only` | yes | no | no | no |
| `propose` *(default)* | yes | yes | yes | no |
| `live` | yes | yes | yes | **no** |

`live` does not unlock money. `gate.ts` hard-codes
`humanApprovalTokenPresent = false`, so `evaluatePolicy` denies any
money-moving or vendor-committing action by construction. This is not a
limitation to be lifted later by configuration — it is the design. An approval
token comes from a human in the console, and the executor of an approved
proposal is a separate server job that no agent can call.

## The proposal path (money, charges, dispatches)

Agent wants to pay a vendor:

```
propose_payment(args)
  → action_proposals row (pending, expires in 7 days)
  → { posted: false,
      policy: { allowedNow: false, requiresHumanApproval: true,
                reasons: ["dry_run", "approval_token_required"] },
      note: "Filed for approval. The ledger has NOT changed." }
```

The row commits nothing, posts no charge, contacts nobody. `args_hash` plus a
partial unique index on pending rows means a retrying agent files **one**
proposal, not ten — verified: `PROPOSE_PAYMENT_REPEAT duplicate=true sameId=true`.

The `note` field is part of the contract. It exists because models narrate
success optimistically; the tool states plainly that no money moved so the
model has nothing to misreport.

## Tickets: same pipeline as WhatsApp

`create_ticket` writes the ticket **and** enqueues the same BullMQ job the
WhatsApp webhook produces (`TRIAGE_QUEUE_NAME`, job `ticket.ingest`),
**strictly after the commit** — a job must never point at an uncommitted row.

If Redis is unreachable at boot, the server still starts (reads keep working)
and the tool reports `triage: { enqueued: false }`. It never pretends the work
was dispatched.

`create_ticket` calls `emergencyPrecheck` from `@aqar/core`. A new ingress path
must not be able to bypass **LAW 2**. Verified on the gas-smell case:

```
emergency=true signals=["gas_smell"] triage.enqueued=true
→ worker: status=triaged category=gas severity=emergency confidence=1
  rationale: "... [deterministic: precheck.emergency=true, signals=gas_smell,
             model.emergencyFlag=true, priorEmergency=true;
             LAW 2: emergency is sticky and a model may raise but never lower it]"
```

## Tool inventory (18)

Reads: `aqar_context`, `portfolio_summary`, `list_vacant_units`,
`list_expiring_leases`, `search_tenants`, `list_arrears`, `tenant_statement`,
`list_open_tickets`, `get_ticket`, `list_vendors`, `list_proposals`.

Reversible writes: `create_ticket`, `log_payment_promise`, `log_tenant_message`.

Proposals only: `propose_payment`, `propose_charge`, `propose_vendor_dispatch`,
`propose_tenant_reply`.

Money is always both fields: `amountFils` (integer, `1 JOD = 1000 fils`) and a
preformatted `amountJod` string. Agents copy the string; they never divide.

Phone numbers come back masked (last four digits). The agent has no need for a
full number to answer "who owes me money".

## Verification

```bash
cd ~/HERMES/aqar && set -a && . ./.env && set +a
cd apps/mcp
pnpm exec tsc --noEmit          # 0
pnpm exec eslint src --max-warnings 0
pnpm exec vitest run            # 35/35
node scripts/smoke.mjs | grep SMOKE_OK   # real client over stdio, live DB
```

The integration suite needs a live Postgres; it skips without `DATABASE_URL`.
`scripts/smoke.mjs` is deliberately not a unit test — it spawns the server the
way Hermes does and prints real rows.

**Never** pipe the smoke run through `tail`: a live `tsx` child holds the
inherited stdout pipe and the command hangs instead of failing. Redirect to a
file and read it.

## Next layer: constraints the agent design must respect

Researched 2026-11-20 from Meta primary docs; these are hard constraints, not
preferences.

- **Service replies are no longer free.** Since 1 Oct 2026, messages inside the
  24-hour window bill at the service rate — Jordan is priced in Meta's
  *Rest of Middle East* band: utility/authentication/service **$0.0091**,
  marketing **$0.0392** per delivered message, with the first **1,000 service
  messages per number per month** free. An agent that replies to everything
  costs ~7¢ per 8-message case. Design for one good reply, not a conversation.
- **Utility → marketing reclassification is silent and instant.** Meta
  re-reviews live templates. If a rent reminder is judged marketing, status
  stays `APPROVED`, it keeps sending, and you are billed 4.3×. Notification
  arrives on the `template_category_update` webhook — subscribe to it and pause
  affected campaigns.
- **Identity is `from_user_id`, not the phone number.** For users with a
  WhatsApp username, `wa_id` and `from` may be **omitted entirely** from the
  webhook. Keying the ledger on `wa_id` drops those messages.
- **Media is ephemeral.** The download URL expires in **5 minutes**; media IDs
  expire in 7 days (webhook-sourced). Fetch inside the worker job, never at
  webhook time; on `404`, re-query the ID for a fresh URL.
- **Ack fast, then work.** Meta's stated bar is median ≤250 ms and retries for
  up to 7 days. Verify the signature over the **raw** body, insert with
  `UNIQUE(message_id)`, return 200, let the worker do OCR and classification.
- **Outbound is gated by a deterministic window check**, not a model decision:
  `now < last_inbound_at + 24h` → free-form; else template path.

For the human chat surface, the load-bearing finding is that streaming chat
history is client-controlled: a crafted approval can bypass an in-UI human
step. The fix is to HMAC-sign each approval at issuance binding tool name +
`toolCallId` + input, and to revalidate against **current** database state on
apply — not the state at request time.

For proactive behaviour, timer-based work becomes an **outbox row written in
the same transaction** as the business fact, with one relay; dedupe is semantic
(`rent_due:lease:<id>:-3d`), never random. The LLM composes prose and
classifies ambiguity; it never computes an amount, a date or an eligibility
decision — those render from typed fields.
