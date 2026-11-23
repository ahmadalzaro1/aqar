#!/usr/bin/env node
/**
 * Folded check runner.
 *
 * Runs every fast check to completion — never stops at the first failure — then
 * prints one table and exits non-zero if anything failed. The point is that a PR
 * shows all of its problems in a single 15-second job instead of the author
 * discovering them one run at a time.
 *
 * Usage: node scripts/ci/checks.mjs [--budget <seconds>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const budgetIx = args.indexOf('--budget');
const budget = budgetIx === -1 ? null : Number(args[budgetIx + 1]);
// --tracked-only: judge what is being pushed, not untracked scratch in the tree
const trackedOnly = args.includes('--tracked-only');
// PR-scoped typecheck: the workflow passes the diff-reachable projects
const projectsIx = args.indexOf('--projects');
const projects = projectsIx === -1 ? null : args[projectsIx + 1];
// one budget per check: a scoped run and a full run are not the same cost
const tcIx = args.indexOf('--typecheck-budget');
// The typecheck budget is a regression tripwire, not a performance target. The
// step runs 13 tsgo processes on 10 cores, so its wall time is dominated by
// memory-bandwidth contention: packages/db alone is 2.1s, but the same project
// measures 5.1s while twelve siblings run. A 5s budget sat inside that noise
// band and failed legitimate pushes (measured 5.0-6.8s on an idle-to-busy
// machine with no code change). 8s sits above the band, so it still catches a
// real regression — a heavy new dependency lands well past it — without
// flaking. Measured 2026-11-23 on the M1 Max host.
const typecheckBudget = tcIx === -1 ? 8 : Number(args[tcIx + 1]);

// Call the binary, not `pnpm exec`: the wrapper costs ~0.5s of the 1s budget
// (measured 0.64s via pnpm vs 0.16s direct on a clean copy).
const OX = existsSync('node_modules/.bin/oxlint') ? 'node_modules/.bin/oxlint' : 'oxlint';
// same reason as oxlint: the wrapper costs more than the check
const OXFMT = existsSync('node_modules/.bin/oxfmt') ? 'node_modules/.bin/oxfmt' : 'oxfmt';
const lintArgv = [OX];
if (trackedOnly) {
  const { execFileSync } = await import('node:child_process');
  const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts', '*.mjs'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !f.startsWith('node_modules/'));
  lintArgv.push(...files);
}

const CHECKS = [
  { name: 'boundaries', argv: ['node', 'scripts/check-core-deps.mjs'], budget: 5 },
  // 0.17s for the whole repo (359 files), and it reads .prettierignore for the
  // files that must not be touched: docs prose, the SQL migrations, fixtures.
  { name: 'format', argv: [OXFMT, '--check', '.'], budget: 1 },
  { name: 'lint', argv: lintArgv, budget: 1 },
  // the parallel tsgo script directly: `pnpm typecheck` adds the same wrapper tax
  {
    name: 'typecheck',
    argv: projects
      ? ['node', 'scripts/ci/typecheck-all.mjs', '--only', projects]
      : ['node', 'scripts/ci/typecheck-all.mjs'],
    budget: typecheckBudget,
  },
];

const started = Date.now();
const results = [];

for (const check of CHECKS) {
  const t0 = Date.now();
  // inherit stdio so a failure's own message stays readable in the log
  const run = spawnSync(check.argv[0], check.argv.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const seconds = (Date.now() - t0) / 1000;
  const ok = run.status === 0;
  const overBudget = seconds > check.budget;
  results.push({ ...check, seconds, ok, overBudget, status: run.status ?? 'signal' });
}

const total = (Date.now() - started) / 1000;
const pad = (s, n) => String(s).padEnd(n);

console.log('\n─── checks ───────────────────────────────────────────────');
console.log(`${pad('check', 14)}${pad('result', 10)}${pad('time', 10)}budget`);
for (const r of results) {
  const verdict = r.ok ? 'pass' : 'FAIL';
  const time = `${r.seconds.toFixed(1)}s`;
  const b = `${r.budget}s${r.overBudget ? '  ⚠ over' : ''}`;
  console.log(`${pad(r.name, 14)}${pad(verdict, 10)}${pad(time, 10)}${b}`);
}
console.log(`\ntotal ${total.toFixed(1)}s`);

const failed = results.filter((r) => !r.ok);
const slow = results.filter((r) => r.overBudget);

if (failed.length > 0) {
  console.log(`\nFAILED: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
// A check that runs over budget is still a failure: the budget is the contract
// that keeps the whole lane under a minute, and a silent drift breaks it.
if (slow.length > 0) {
  console.log(
    `\nOVER BUDGET: ${slow.map((r) => `${r.name} ${r.seconds.toFixed(1)}s > ${r.budget}s`).join(', ')}`,
  );
  process.exit(1);
}
if (budget !== null && total > budget) {
  console.log(`\nOVER JOB BUDGET: ${total.toFixed(1)}s > ${budget}s`);
  process.exit(1);
}
console.log('\nall checks passed');
