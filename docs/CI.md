# CI

Four independent jobs, no job waiting on another, each enforcing its own budget.
Numbers below are measured on this repo, not aspirational.

## What runs

| job | what | budget (wall) |
| --- | --- | --- |
| `checks` | boundaries → lint (oxlint) → typecheck (tsgo), all of them, one table | 40 s |
| `build` | `pnpm build` (Next production build) | 60 s |
| `test` | core unit + property, ui, web offline, agents offline | 45 s |
| `integration` | Postgres/Redis/Mailpit services, migrations, db + worker + channels + evals | 90 s |

The full suite runs on `main`, on every PR, and in the merge queue. PR selection
only *narrows* test execution; it never narrows `checks`, `build`, or migrations.

## Hard rules

1. **The full suite runs before anything reaches main.** The `merge_group`
   trigger exists for that; see "Merge queue" below.
2. **No retries, no widened timeouts, no skipped tests.** A flaky check is a bug
   in the check. `checks.mjs` deliberately does *not* retry.
3. **Checks only stay or grow.** `checks.mjs` runs every check to completion and
   fails once, listing all failures — it can never mask one behind a later pass.

## Budgets are enforced, not documented

Each job records `JOB_START` in its first step and calls
`scripts/ci/budget.mjs` in an `always()` step. Going over fails the job. The
budget lives next to the work it constrains, so drift is a red build rather than
a slow drift nobody notices.

Measured locally (Mac Studio M1 Max, 32 GB — the runner is slower on single-core
bounds, faster on the parallel ones):

| check | before | after | budget |
| --- | --- | --- | --- |
| lint (`eslint .` → `oxlint`) | 5.35 s | **0.07 s** | 1 s |
| typecheck (`tsc` → `tsgo`) | 15.79 s | **3.50 s** | 5 s |
| boundaries | 0.1 s | 0.1 s | 5 s |
| full offline suite (vitest) | 5.9 s | 5.9 s | 30 s/shard |
| `pnpm build --force` | 34.8 s | 34.8 s | 60 s |

## Rerun-everything inputs

Selection is only trusted to narrow when a change is clearly owned by one
workspace package. Any of these reruns every test:

- `pnpm-lock.yaml`
- any `package.json`
- `turbo.json`, any `tsconfig*.json`, any `vitest*.config.*`
- `.github/**`, `scripts/**`, `.ci/**`
- `eslint.config.*`, `.oxlintrc.json`
- any changed file outside `packages/*` and `apps/*`

Beyond that, a change to package A also runs every package that declares a
dependency on A (reverse-dependency closure). `scripts/ci/select-tests.selftest.mjs`
pins this behaviour with fixtures — a selector that silently under-selects is
worse than none.

## Shards

`scripts/ci/shard.mjs` balances by *measured* file times from
`.ci/test-times.json` (recorded on main with `--record`), not by file count, and
`--verify` fails unless the shards together contain every recorded file exactly
once.

Today the whole offline suite is ~6 s, so it runs as one shard: four shards of a
6-second suite pay four containers and four installs to save nothing. Sharding
turns on when a package's recorded total passes ~20 s, which is a one-line change
in the workflow (`--shards N --index ${{ matrix.shard }}`).

## Merge queue

Enable "Require merge queue" on `main` with these required checks:
`checks`, `build`, `tests (unit · property · offline)`,
`tests (postgres · redis · mailpit)`. The queue batches PRs, runs the full suite
on the merged result, and only then fast-forwards `main`.

## Local

`pnpm install` sets `core.hooksPath=.githooks` (via the `prepare` script), so the
hooks are not opt-in:

- `pre-commit`: banned escapes in *added* lines (`any`, `@ts-ignore`,
  `eslint-disable`) and `oxlint --deny-warnings` on staged files — under 1 s.
- `pre-push`: runs `node scripts/ci/checks.mjs`, byte-identical to the CI checks
  job (~4 s).

## Deliberate deviations

- **No Blacksmith.** The repo is public on a free plan: hosted minutes cost $0.
  Measured waiting on the old pipeline was 2–3 s against a 5 s budget, so a paid
  runner migration buys nothing measurable. Revisit if the repo goes private or
  waiting exceeds 5 s at p95.
- **No formatter.** This repo has never had Prettier, Biome or `oxfmt`; adding
  one means reformatting every file once. Not done silently inside a CI change —
  it is its own decision with its own diff.
- **ESLint kept only as an oracle.** `scripts/ci/lint-parity.mjs` installs ESLint
  ad hoc at a pinned version and fails if oxlint misses a finding ESLint reports.
  Delete it and `scripts/ci/eslint-reference.config.mjs` on 2026-12-05.

## Toolchain pins

- `oxlint@1.94.0` — exact pin, rule registration verified rule-by-rule.
- `@typescript/native-preview@7.0.0-dev.20260707.2` — a canary, pinned exactly,
  as the rules require.
- `no-octal` is the one ESLint rule with no oxlint equivalent; TypeScript
  rejects legacy octal outright (`TS1121`), verified, so coverage is total.
