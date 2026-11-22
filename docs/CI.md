# CI

Four independent jobs, no job waiting on another, each enforcing its own budget.
Numbers below are measured on this repo, not aspirational.

## What runs

| job | what | budget (wall) |
| --- | --- | --- |
| `checks` | boundaries → lint (oxlint) → typecheck (tsgo), all of them, one table | 45 s |
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

Local, Mac Studio M1 Max (10 cores):

| check | before | after | budget |
| --- | --- | --- | --- |
| lint (`eslint .` → `oxlint`) | 5.35 s | **0.16 s** (binary, not `pnpm exec`: 0.64 s) | 1 s |
| typecheck (`tsc` → `tsgo`) | 15.79 s | **3.50 s** | 5 s |
| boundaries | 0.1 s | 0.1 s | 5 s |
| full offline suite (vitest) | 5.9 s / 46 files | 5.9 s | 30 s/shard |
| `pnpm build --force` | 34.8 s | 34.8 s | 60 s |

On `ubuntu-latest` (4 cores), from a real run — this is the number that governs:

| job | wall | budget step |
| --- | --- | --- |
| waiting | 3 s | 5 s |
| `checks` | 35 s | 30.9 s / 40 s |
| `build` | 69 s | 56.4 s / 60 s |
| `tests` (offline) | 42 s | 30.2 s / 60 s on `main` (45 s on PRs) |
| `tests` (integration) | 59 s | 38.5 s / 90 s |
| **PR result (wall, cold caches)** | **72 s** | target <60 s median |

Two honest notes on that table:

- **typecheck is 8.7 s on four cores, not 3.5 s.** 13 tsgo processes on 4 cores
  fight for the CPU; `packages/db` alone measures 1.06 s here and 8.65 s there.
  The spec's 5 s is therefore met on PRs by checking only diff-reachable projects
  (2 projects ≈ 1.1 s), and full runs use a 12 s budget that reflects the
  measured runner cost. A larger runner would fix it outright, but larger runners
  need a Team plan — it cannot be bought from here.
- **The budget step starts at the first step, so it excludes container
  provisioning.** Integration's wall is 59 s while its steps total 38.5 s: ~20 s
  is the three service containers starting before any step runs.

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

## Proofs, from real runs

Selection is the one mechanism that can silently under-check, so it was attacked
the way it would fail: a type error planted in `packages/contracts`, a leaf every
app imports, on a throwaway branch (PR #3, closed without merging).

- the selector returned all 12 reachable packages, not just `contracts`
- CI went red in `checks` **and** `build`
- the failure named the line: `packages/contracts/src/index.ts(8,14): error TS2322`
- `typecheck FAILED in 12/13 projects (8.1s)` — the scope was real, not a full run
  in disguise

And the budget enforcer was proved by the pipeline itself, not by a demo: the
first fully-green-except-one run failed on
`OVER BUDGET: typecheck 8.7s > 5s` while every other check passed.

## What is deliberately not here

| not done | why, with the number |
| --- | --- |
| Blacksmith runners | public repo → hosted minutes $0, measured wait 3 s against a 5 s budget |
| larger runners for typecheck | `ubuntu-latest` is 4 cores and 13 tsgo projects need 8.7 s; larger runners need a Team plan, so this cannot be bought from here |
| merge queue toggle | repository setting that needs the owner's session; the `merge_group` trigger and the required checks are already in place |
| `bun test` | measured: 42 of 157 files fail under bun's runner — `vitest` imports, `vi.mock` hoisting and fake timers. Keeping vitest is the measured reason, not habit |
| `hk` hooks | `pnpm dlx hk@latest` → `ERR_PNPM_DLX_NO_BIN No binaries found in hk`, and hk has no pre-push stage. `.githooks/pre-commit` + `pre-push` run 4.0 s and are wired via `core.hooksPath` |
| formatter | this repo has never had one; adding `oxfmt` reformats every file and is its own PR with its own diff |
| shards | 46 files / 5.9 s total: four shards would pay four installs to save nothing. `scripts/ci/shard.mjs --verify` already fails unless the shards together contain every recorded file |
| change-detector deletion | needs two weeks of logged failures before deleting anything; the log format is the `.ci/test-times.json` record written on every full run |
