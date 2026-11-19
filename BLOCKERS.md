# Blockers and resume point

Updated: 2026-11-19 (Asia/Amman)

## Environment blockers encountered (resolved or worked around)
1. Docker daemon (colima) was stopped → started it (4 CPU / 8 GiB VM).
2. `minio/minio` removed from Docker Hub; `quay.io/minio/minio` 401 →
   dev compose uses community mirror `coollabsio/minio:latest` (see D6).
   Production needs a verified S3 image or managed S3. NOT a code blocker.
3. pnpm 11 ignores package.json `pnpm` field → `allowBuilds` in
   pnpm-workspace.yaml (esbuild approved).

## Current phase: P0/P1/P4-deterministic in flight
Four parallel builders are implementing:
- packages/core/src/ledger (money engine + property tests)
- packages/core/src/terms (lease/owner/reconciliation math + property tests)
- packages/core/src/ops (emergency pre-check, LAW-2 merge, SLA, policy, metrics)
- packages/db (full schema, up/down migrations, RLS, guards, seed)
Parent lane: apps/web console (shell, auth AR/EN, dashboard, ledger, tickets),
packages/ui tokens/primitives, CI, docs — written, awaiting integration.

## Exact resume point (next actions in order)
1. Wire packages/core/src/index.ts barrel: export * from ledger/terms/ops.
2. Reconcile apps/web/src/lib/queries.ts column names with the landed
   packages/db schema (raw SQL was written against the frozen spec names).
3. pnpm typecheck && pnpm lint && node scripts/check-core-deps.mjs — fix fallout.
4. pnpm db:migrate && pnpm db:seed against compose Postgres :5433.
5. Boot pnpm dev; verify login AR+EN, dashboard KPIs, ledger month view,
   emergency banner on the seeded Arabic gas ticket; capture screenshots.
6. Commit per logical unit (no spam); then P2/P3 UI depth, P5 agent layer
   (packages/agents, apps/worker, apps/channels, packages/evals), P6–P10.

## Not built yet (honest)
apps/worker, apps/channels, packages/agents, packages/evals, M2/M6/M7/M8/M9
UI screens beyond the console slice, Playwright e2e, a11y CI job, perf
measurement, NL query. No fabricated results anywhere in this repo.
