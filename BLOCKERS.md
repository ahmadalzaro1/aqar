# Blockers and resume point

Updated: 2026-11-20 (Asia/Amman)

## Verified state (all numbers from real command output)
- `pnpm typecheck` 13/13 tasks · `pnpm lint` clean · LAW-1 gate PASS.
- Suites: core 361/361 · agents 23 (+2 live-gated) · db 9/9 (real PG) ·
  ui 5/5 · worker 13/13 · channels 34/34 (live webhook+Mailpit) · evals 19/19.
- Worker live E2E PASSED (real Redis+PG+lfm3-local :11434): Arabic gas ticket
  → deterministic emergency floor held while the model under-called "high"
  → 3 dry_run policy proposals → 0 dispatches → bilingual safety messages →
  idempotent replay, zero duplicate rows.
- Evals: deterministic recall 1.0000 / FP 0.00% on **60 cases** (38 emergencies,
  category accuracy 38/38); live-model lane recall 1.0000 / FP 0.00%
  (results/ JSON committed). All 5 former coverage gaps CLOSED in core
  (commit 57ad445) and promoted into the golden set; on the new chemical-fume
  case the model emitted an invalid category, schema escalation fired, and
  the deterministic floor kept emergency+gas — LAW-2 proven on a new class.
- 40 screenshots (5 pages × AR/EN × 1440/1024/768/390) in docs/screenshots/,
  captured with real CDP device-metrics emulation and verified two ways:
  (a) measurement — 40/40 runs with scrollWidth == clientWidth and zero
  overflow offenders inside <main>; (b) visual — vision review of the 390px
  EN/AR bank and statement captures, which found defects the probe could not
  (all fixed: see the 2026-11-20 commits).

## Environment blockers (resolved or worked around)
1. colima stopped → started. `minio/minio` gone from Hub, quay 401 →
   `coollabsio/minio:latest` dev mirror (D6); production needs verified S3.
2. pnpm 11 build allowlist → `allowBuilds` in pnpm-workspace.yaml
   (esbuild + msgpackr-extract approved).
3. (RESOLVED 2026-11-20) Postgres host auth. Two things were conflated. The
   container image ships `pg_hba.conf` with `trust` for loopback *inside* the
   container and `host all all all scram-sha-256` for everything else; a host
   client arrives on the docker bridge address, so it has always been subject
   to real SCRAM. The repeated "SCRAM failures" were a **wrong password**, not
   an auth-method incompatibility: the same class of 3-character-vs-4-character
   credential mismatch that broke CI (see the P1 note below).
   Evidence: the volume recreate (PG 19) restored the default hba, the
   `172.16.0.0/12 trust` band-aid is gone, `password_encryption =
   scram-sha-256`, and a host `psql -h 127.0.0.1 -p 5433` with the correct
   password authenticates. `DATABASE_URL` was corrected to match the
   compose password.
   STILL OPEN and separate: role `aqar` is `rolsuper` + `rolbypassrls`, so RLS
   is inert for the application role even though the policies are correct.
   That must be fixed before any non-local exposure (see SECURITY.md).
4. `.env` had a stray non-comment line and stale LOCAL_BASE_URL=:8002
   (embeddings-only, chat 404) → fixed; chat model is lfm3-local :11434.
5. CDP device-metrics emulation DOES drive the media queries (verified:
   `matchMedia('(max-width: 900px)')` is true at 390px). The earlier iframe
   captures were a workaround for a misconfigured override; screenshots now
   use `Emulation.setDeviceMetricsOverride` + `captureBeyondViewport`, which
   is also faithful about the fixed rail.

## Open items (honest, prioritized)
- P1 (CLOSED 2026-11-20): M6 bank-import wizard (`/bank`) and M7 owner
  statement (`/statements`) shipped and proven end to end. Commit 0a2328d,
  CI run 44739777530 = success. Bank: 5 offline
  tests + live write path (payments 85 -> 86, allocations 84 -> 85, audit
  +2, charge settled to 0 fils, replay returns `already_imported` with zero
  new writes) plus a real UI run (paste -> analyze -> confirm -> "Import
  committed", payments 86 -> 87). Statement: 10 offline tests + UI issue ->
  `owner_statements` row (gross 1,160,000 / fee 92,800 @800 bps / expenses 0
  / net 1,067,200) + 3 draft distributions summing exactly to net + audit
  `owner_statement.issue`; the button flips to a disabled "Issued". Every
  amount comes from `packages/core`; expenses use real completed-work costs
  only, and the seed's fabricated 9%-of-rent expense figure is never shown.
- P1 (CLOSED 2026-11-20): CI is GREEN on GitHub — run 44709859409 (48 s).
  Root cause of the earlier integration failure was a corrupted 3-character
  password in the workflow's `DATABASE_URL` versus the 4-character
  `POSTGRES_PASSWORD` on the service container, not billing. The private-run
  refusal is still unexplained on the billing side; the repo stays public.
- FIXED (2026-11-20): the Shell's "below 900px the sidebar is a 56px icon
  rail" never actually applied. `inline-size` was set with `flex-shrink: 0`
  and an implicit `flex-basis: auto`, so the flex item's automatic minimum
  (its min-content width, 220px) won and the sidebar stayed 220px wide on a
  390px phone, starving `<main>` to 170px. Fixed by giving the aside an
  explicit `flexBasis`, `minInlineSize: 0` and `maxInlineSize`; bank/statement
  controls also got `inlineSize: 100%` + `minmax(0, 1fr)` grids so no form
  control contributes an intrinsic width.
  Measured with real viewport emulation (not eyeballed, not a scrolling
  iframe): 5 pages x 4 widths x 2 locales = 40 runs, 0 overflow offenders.
  Commit 36ee993; CI run 44742653326 = success.
  390px: aside 56 / main 334. 768px: 56 / 712. 1024px: 220 / 804.
  1440px: 220 / 1220. Document scrollWidth == clientWidth in every run.
- P2: `packages/db/src/client.ts` still has a placeholder default URL and no
  dotenv load (B2); every script/test passes DATABASE_URL explicitly, and
  db vitest now derives aqar_test from the real env. Fix: fail-fast on the
  placeholder or load .env in client/migrate.
- P2: classifier small-model vocabulary drift: `ar-noise-complaint` makes
  lfm3-local emit category "noise" (not in the frozen enum) → schema
  escalation to human (fail-safe, recorded in the model-lane JSON). The
  prompt now lists the exact enum; `en-cleaning` drift was fixed this way.
- P3: Playwright e2e, a11y CI job, perf budgets, NL query, M2/M8/M9 screens,
  TOTP enrolment UI, rate limiting, encryption-at-rest (P9/P10).
- P3: policy.ts `nte_exceeded` comment wording ambiguous (doc-only fix).

## Dependency refresh (2026-11-20) — every package, action and image at newest
- Merged to `main` as four verified layers (rebase, linear): `0754bd5` actions
  v7/v6/v7 + PostgreSQL 19 + Redis 8 + Node 26 CI; `ac7d02f` TypeScript 6.0.3
  + ESLint 10 + vitest 5; `00e5c8f` Next 16.4.6 / React 19.3.1 / zod 4 /
  postgres 4; `70cab79` nodemailer 10.
- CI: run 44748254781, 44752788669, 44752992202 — all success on clean runners.
- Local gates after the whole sweep: ALL_GATES_GREEN 14/14 (core-deps, lint,
  typecheck, core-unit 309, core-property 52, core 361 total, ui 5, web 20,
  agents 23 + 2 skipped, db-migrate, db 9 on PostgreSQL 19.0, db-seed,
  worker 13 on Redis 8.10.3, channels 34 with real SMTP, evals recall 1.0000).
- Runtime proof, not build-only: `next build --webpack` exits 0 with zero
  warnings across 9 routes; a real login through the Next 16 server action
  redirects to `/dashboard` and renders 8 rows in Arabic RTL.
- **Hold 1 — TypeScript is 6.0.3, not 7.0.2.** `typescript-eslint@8.73` peers
  `typescript >=4.8.4 <6.1.0` and `pnpm peers check` enforces it. This is the
  only row `pnpm outdated -r` still reports.
- **Hold 2 — Next 16 builds with webpack.** Turbopack cannot resolve the
  workspace packages' NodeNext `.js` -> `.ts` specifiers and fails on
  `sumFils`. `--webpack` is explicit in the scripts; the fix path (emit real
  `.js` from `packages/*`, point `exports` at `dist`) is D13.
- Also fixed in passing: `scripts/gate-sweep.sh` was grepping an accumulated
  log, so gates that print no counts echoed the previous gate's numbers. It now
  reads each gate's own output and exits non-zero on failure.

## Proactive engine — 2026-11-21

Built and proven against the live database (`aqar-demo`, 21 overdue charges,
20 open tickets, 2 expiring leases, 1 of the tickets flagged emergency).

**Real cycle output** (`[proactive] scan=43 published=43 intents=5 sent=3
deferred=0 suppressed=2 expired=0 localHour=19`):

| trigger | tier | outcome |
|---|---|---|
| `emergency_unacknowledged` | 0 | delivered — its own message, out of the digest |
| `rent_overdue` (21 items) | 1 | delivered as one digest |
| `ticket_sla_breach` (19 items) | 2 | delivered as one digest |
| `lease_expiring` ×2 | 2 | suppressed `daily_budget`, left `open` for tomorrow |

43 facts → 5 intents → 3 messages. The same run before digesting produced 43
intents and 41 budget suppressions, i.e. the two most important facts were
competing with 41 duplicates for one slot.

**Gates:** `ALL_GATES_GREEN` (15 gates). Worker `26 passed`, core `339 + 52`,
channels `34`, mcp `35`, web `24`, db `9`, agents `23 (+2 skipped)`, evals
recall `1.0000`. `tsc` and `eslint --max-warnings 0` clean.

**Migrations:** `0004_notifications` (three tables) and `0005_outbox_no_touch_trigger`
(the correction; see below), both applied with down migrations present.

Defects found *by running it*, all fixed:

1. `sql.array()` does not exist in postgres.js v4 — the relay's publish step
   threw and rolled back the whole transaction, so intents were created and then
   discarded. Silent: every test asserted on the pre-transaction state.
2. Migration 0004 attached the `updated_at` touch trigger to `outbox`, which has
   no such column → `record "new" has no field "updated_at"` on every publish.
   Fixed forward in `0005` because an applied migration is the record of what
   ran.
3. The ledger was stamped with SQL `now()` while the policy decided on an
   injected `now` — the daily budget could never see its own sends once the two
   differed. Both now use the same instant.
4. An SLA breach on an **emergency** ticket was being folded into the T2 daily
   digest, which is a LAW 2 violation in the notification layer: the safety
   signal was aggregated. It is now reclassified to T0 `emergency_unacknowledged`
   by the deterministic flag, before any text is generated.
5. Two orphaned `apps/worker` processes from earlier runs were still consuming
   the queue (my `pkill` pattern missed `cli.mjs src/index.ts`). Two workers on
   one queue means double processing and lock contention — this is what the
   channels teardown fix was papering over.

**Not done (honest):**

- **No real channel.** `ChannelSender` is implemented only as `createLogSender`;
  nothing reaches WhatsApp, Telegram or email. Delivery is a log line plus a
  `notification_sends` row. Templates (pre-approved, `utility` category) are a
  prerequisite and are not written.
- **No acknowledgement surface.** `notification_intents` has `acked`/`declined`
  states and `canReopen`/cooldown in core, but nothing in the console sets them,
  so every intent currently ends its life as `notified` or `expired`.
- **No recipient model.** Caps are per-organization; `humanSentToday` counts the
  org, because nothing maps a property or a ticket to a responsible user yet.
- **Digest immutability is one-way.** A digest that has been delivered is frozen;
  facts arriving later that day land in the next cadence bucket rather than a
  follow-up. Acceptable, but it means a delivered digest can understate the day.
- **Suppression evidence is per day.** There is no long-term history of what was
  suppressed, so tuning the caps has no dataset yet.

## Agent layer (MCP) — 2026-11-20
- `apps/mcp` (`@aqar/mcp`) registered with Hermes as `aqar`: **18/18 tools**,
  mode `propose`, actor `hermes`. See `docs/AGENTS.md`.
- Verified end-to-end: `tsc` 0 · `eslint` 0 · `vitest` **35/35** ·
  `node scripts/smoke.mjs` → `SMOKE_OK`. A gas-smell ticket filed over MCP was
  consumed by the worker and classified `emergency / confidence 1`, ticket
  status moved `new → triaged`.
- Money denied by construction: `humanApprovalTokenPresent = false`, so
  `evaluatePolicy` returns `allowed: false` for every money/vendor action and
  the tool files a pending `action_proposals` row instead.
- Fixed in passing (pre-existing defect): the worker never moved
  `tickets.status` off `new` after classifying, so the console showed untriaged
  tickets forever.
- **Not done yet:** WhatsApp templates + media ingestion, proactive
  outbox/scheduler, human chat surface, approvals inbox, proposal executor job.
  The researched constraints that bound them are in `docs/AGENTS.md` § Next
  layer and `docs/DECISIONS.md` D17.

## Exact resume point
1. Next up: retire the RLS hole (role `aqar` is superuser + `rolbypassrls`;
   policies are correct but never evaluated for that role) — split an
   application role from the migration/owner role and re-run the db suite.
2. Then the P2 tail: B2 dotenv fail-fast in the db client/migrate;
   `ar-noise-complaint` prompt hint.
3. Then P3 UI depth (history/undo surface, playwright e2e, a11y and perf jobs)
   and P6–P10.
4. `main` is green at `70cab79`+; keep it that way — any push re-runs the full
   sweep. The toolchain is current except TypeScript, which is held at 6.0.3 by
   the linter's peer range (see the refresh section above).
No fabricated results anywhere in this repo.
