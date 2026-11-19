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
- Evals: deterministic recall 1.0000 / FP 0.00%; live-model lane recall 1.0000
  / FP 0.00%, p50 647ms / p95 880ms, 17,982 tokens (results/ JSON committed).
- 24 screenshots (3 pages × AR/EN × 1440/1024/768/390) in docs/screenshots/,
  every capture verified scrollWidth == viewport width.

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
5. CDP device emulation did not drive media queries reliably → screenshots
   captured via same-origin iframe at exact px width (method in RUNBOOK).

## Open items (honest, prioritized)
- P1: bank-import wizard + owner-statement UI screens not built (M6/M7);
  their screenshots are therefore absent — not faked.
- P1: CI workflow exists (.github/workflows/ci.yml) but has never run on
  GitHub; every command it contains was run locally and is green.
- P2: `packages/db/src/client.ts` still has a placeholder default URL and no
  dotenv load (B2); every script/test passes DATABASE_URL explicitly, and
  db vitest now derives aqar_test from the real env. Fix: fail-fast on the
  placeholder or load .env in client/migrate.
- P2: classifier small-model vocabulary drift: `ar-noise-complaint` makes
  lfm3-local emit category "noise" (not in the frozen enum) → schema
  escalation to human (fail-safe, recorded in the model-lane JSON). The
  prompt now lists the exact enum; `en-cleaning` drift was fixed this way.
- P2: deterministic catalogue coverage gaps (5 phrasings, documented in
  evals KNOWN_COVERAGE_GAPS): overflowing bathtub, water everywhere,
  sagging ceiling, Arabic chemical fumes, Arabic elevator entrapment
  variant. Core change, reported upward; gate NOT weakened.
- P3: Playwright e2e, a11y CI job, perf budgets, NL query, M2/M8/M9 screens,
  TOTP enrolment UI, rate limiting, encryption-at-rest (P9/P10).
- P3: policy.ts `nte_exceeded` comment wording ambiguous (doc-only fix).

## Exact resume point
1. Build M6 bank-import wizard + M7 owner statement pages; shoot them at
   4 widths × AR/EN with the iframe method.
2. Push branch + let GitHub Actions run ci.yml; fix any runner-only fallout.
3. B2 fail-fast in db client/migrate; then P2 UI depth and P6–P10.
No fabricated results anywhere in this repo.
