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
3. Postgres host SCRAM auth failed repeatedly (root cause unresolved,
   arm64-native image). DEV-ONLY workaround: `host all all 172.16.0.0/12
   trust` in container pg_hba.conf; port bound to loopback. See SECURITY.md.
   MUST be removed before any non-local exposure.
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

## Exact resume point
1. P2 tail: B2 dotenv fail-fast in the db client/migrate; `ar-noise-complaint`
   prompt hint. Then P3 UI depth (history/undo surface, playwright e2e,
   a11y and perf jobs) and P6–P10.
2. CI is green; keep it that way — any push re-runs the full sweep.
No fabricated results anywhere in this repo.
