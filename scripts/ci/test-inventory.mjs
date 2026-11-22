#!/usr/bin/env node
/**
 * A test that stops being collected is invisible to every other check.
 *
 * `vitest run` exits 0 whether it ran 46 files or 3. A renamed helper, a dropped
 * `describe`, a config glob that stops matching — all look like a green suite, and the
 * "how many tests ran?" answer in the log is a number nobody diffs.
 *
 * So: record every test's identity on a full run, and on the next full run compare.
 *   - a test that existed and is gone      → FAIL. Something was silently lost.
 *   - a test that is new                   → pass, but it must be recorded (`--record`).
 *
 *   node scripts/ci/test-inventory.mjs --record     # rewrite .ci/test-inventory.json
 *   node scripts/ci/test-inventory.mjs --check      # compare against it
 *
 * Identity is `package :: file :: full name` — status is NOT part of the identity, so a
 * test that starts failing is still "present" and is caught by the suite itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const INVENTORY = '.ci/test-inventory.json';
const ROOTS = ['packages', 'apps'];

// The offline suite: the packages whose tests need no service container. This mirrors
// the `test` job in ci.yml — the integration job owns db/channels/worker/evals, which
// cannot run without Postgres, Redis and Mailpit.
const DEFAULT_PACKAGES = ['packages/core', 'packages/ui', 'apps/web', 'packages/agents'];
const onlyIx = process.argv.indexOf('--packages');
const packages = onlyIx === -1 ? DEFAULT_PACKAGES : process.argv[onlyIx + 1].split(',').filter(Boolean);
for (const dir of packages) {
  if (!existsSync(`${dir}/package.json`)) {
    console.error(`inventory: no package at ${dir}`);
    process.exit(1);
  }
}
// every declared package must still exist, so a dropped filter is visible here too
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const manifest = `${root}/${name}/package.json`;
    if (!existsSync(manifest)) continue;
    const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts || {};
    if (scripts.test && !packages.includes(`${root}/${name}`)) {
      console.log(`inventory: ${root}/${name} has a test script but is not in the offline set`);
    }
  }
}

// Only tracked files count. An untracked test runs on the machine that has it and on no
// other, so recording it makes the inventory a record of one person's working tree — the
// exact way a local baseline passes and the runner reports every one of its tests as lost.
const { execFileSync: run } = await import('node:child_process');
let tracked;
try {
  tracked = new Set(
    run('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean),
  );
} catch {
  // No git (a bare extract, a tarball). Nothing can be known to be untracked, so say so:
  // a silently unfiltered inventory is how a local baseline records a test the runner
  // will never see.
  console.error('inventory: no git repository — cannot tell tracked from untracked files; recording everything');
  tracked = null;
}
const untrackedSeen = new Set();

const out = [];
const tmp = '.ci/.inventory-run.json';

for (const dir of packages) {
  rmSync(tmp, { force: true });
  try {
    execFileSync(
      'pnpm',
      ['--filter', `./${dir}`, 'exec', 'vitest', 'run', '--reporter=json', `--outputFile=${resolve(tmp)}`],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CI: '1' } },
    );
  } catch (error) {
    // A failing test is the suite's business, not the inventory's: still record what ran.
    const stderr = String(error.stderr || '');
    if (!existsSync(tmp)) {
      console.error(`inventory: ${dir} produced no report — ${stderr.split('\n')[0]}`);
      process.exit(1);
    }
  }
  if (!existsSync(tmp)) continue;
  const report = JSON.parse(readFileSync(tmp, 'utf8'));
  for (const file of report.testResults || []) {
    const rel = resolve(file.name).replace(`${resolve('.')}/`, '');
    if (tracked && !tracked.has(rel)) {
      untrackedSeen.add(rel);
      continue;
    }
    for (const assertion of file.assertionResults || []) {
      const full = assertion.fullName || assertion.title || '(unnamed)';
      out.push(`${dir} :: ${rel} :: ${full}`);
    }
  }
}
rmSync(tmp, { force: true });

for (const rel of untrackedSeen) {
  console.log(`inventory: skipping untracked ${rel} (it exists only in this working tree)`);
}
const unique = [...new Set(out)].sort();
const record = out.length - unique.length;
if (record > 0) console.error(`inventory: ${record} duplicate test name(s) — names must be unique per file`);

if (process.argv.includes('--record')) {
  mkdirSync('.ci', { recursive: true });
  writeFileSync(INVENTORY, `${JSON.stringify({ count: unique.length, tests: unique }, null, 2)}\n`);
  console.log(`inventory recorded — ${unique.length} tests across ${packages.length} packages → ${INVENTORY}`);
  process.exit(record > 0 ? 1 : 0);
}

if (!existsSync(INVENTORY)) {
  console.error(`inventory: ${INVENTORY} is missing — run with --record and commit the result`);
  process.exit(1);
}

const known = new Set(JSON.parse(readFileSync(INVENTORY, 'utf8')).tests);
const now = new Set(unique);
const lost = [...known].filter((t) => !now.has(t));
const added = [...now].filter((t) => !known.has(t));

if (added.length > 0) {
  console.log(`inventory: ${added.length} new test(s) — record them: node scripts/ci/test-inventory.mjs --record`);
}
if (lost.length > 0) {
  console.error(`\ninventory: ${lost.length} test(s) no longer run:\n`);
  for (const t of lost.slice(0, 40)) console.error(`  - ${t}`);
  if (lost.length > 40) console.error(`  … and ${lost.length - 40} more`);
  console.error(
    '\nA test that stops running is a check that stopped checking. Restore it, or remove it\n' +
      'from the inventory in a commit that says why (never as a side effect of another change).',
  );
  process.exit(1);
}
console.log(`inventory ok — ${unique.length} tests, none lost`);
process.exit(record > 0 ? 1 : 0);
