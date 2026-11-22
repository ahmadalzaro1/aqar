#!/usr/bin/env node
/**
 * Typecheck every workspace project in parallel with the native compiler.
 *
 * `turbo run typecheck` schedules one process per package and pays turbo's graph
 * overhead; tsgo is fast enough (0.1–1.0s per project) that the right shape is
 * simply to start them all at once and aggregate. Ordering is irrelevant because
 * every project is checked from source (--noEmit), not from build output.
 *
 * Exits non-zero if any project reports a diagnostic, and prints each project's
 * own diagnostics untouched so the fix is never lossy.
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';

const ROOTS = ['packages', 'apps'];
const TSGO = existsSync('node_modules/.bin/tsgo') ? 'node_modules/.bin/tsgo' : 'tsgo';

const projects = [];
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const dir = `${root}/${name}`;
    const manifest = `${dir}/package.json`;
    if (!existsSync(manifest) || !existsSync(`${dir}/tsconfig.json`)) continue;
    const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts || {};
    if (!scripts.typecheck) continue;
    projects.push(dir);
  }
}

// --only <csv of package dirs>: typecheck just those. Used on pull requests, where
// the diff decides which projects can have changed. main and the merge queue always
// run every project — this narrows feedback, never the gate.
const onlyIx = process.argv.indexOf('--only');
const only = onlyIx === -1 ? null : new Set(process.argv[onlyIx + 1].split(',').filter(Boolean));
const selected = only ? projects.filter((d) => only.has(d)) : projects;
if (only && selected.length === 0) {
  console.log('typecheck skipped — no project can be reached by this diff');
  process.exit(0);
}

const started = Date.now();
const runOne = (dir) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(TSGO, ['-p', `${dir}/tsconfig.json`, '--noEmit'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ dir, code, out, seconds: (Date.now() - t0) / 1000 }));
  });

const results = await Promise.all(selected.map(runOne));
const failed = results.filter((r) => r.code !== 0);
const worst = results.reduce((a, b) => (b.seconds > a.seconds ? b : a), results[0]);
const total = (Date.now() - started) / 1000;

if (failed.length > 0) {
  for (const r of failed) {
    console.error(`\n─── ${r.dir} (exit ${r.code}) ───`);
    console.error(r.out.trimEnd());
  }
  console.error(`\ntypecheck FAILED in ${failed.length}/${results.length} projects (${total.toFixed(1)}s)`);
  process.exit(1);
}
console.log(`typecheck ok — ${results.length} projects in ${total.toFixed(1)}s (slowest ${worst.dir} ${worst.seconds.toFixed(2)}s)`);
