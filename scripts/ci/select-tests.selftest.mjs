#!/usr/bin/env node
/**
 * Tests for the test selector.
 *
 * A selector that silently under-selects is worse than no selector, so its
 * behaviour is pinned by fixtures: the cases below assert that a change reaches
 * the package that owns it, reaches every package that depends on it, and that
 * shared inputs escalate to a full run.
 *
 *   node scripts/ci/select-tests.selftest.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (files) =>
  JSON.parse(execFileSync('node', ['scripts/ci/select-tests.mjs', '--files', files], { encoding: 'utf8' }).trim());

const deps = new Map();
for (const root of ['packages', 'apps']) {
  for (const name of execFileSync('ls', [root], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
    const manifest = `${root}/${name}/package.json`;
    try {
      const p = JSON.parse(readFileSync(manifest, 'utf8'));
      deps.set(`${root}/${name}`, Object.keys({ ...p.dependencies, ...p.devDependencies }).filter((d) => d.startsWith('@aqar/')));
    } catch {
      /* not a package */
    }
  }
}

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${label}: ${e.message}`);
  }
};

console.log('selector fixtures');

check('a core source change selects core', () => {
  const r = run('packages/core/src/ledger/money.ts');
  if (r.mode !== 'affected') throw new Error(`mode=${r.mode}`);
  if (!r.packages.includes('packages/core')) throw new Error('core not selected');
});

check('a core change selects every declared dependent', () => {
  const r = run('packages/core/src/ledger/money.ts');
  const dependents = [...deps].filter(([, d]) => d.includes('@aqar/core')).map(([dir]) => dir);
  const missing = dependents.filter((d) => !r.packages.includes(d));
  if (missing.length) throw new Error(`dependents not selected: ${missing.join(', ')}`);
});

check('a web-only change does not drag in unrelated packages', () => {
  const r = run('apps/web/src/app/page.tsx');
  if (r.mode !== 'affected') throw new Error(`mode=${r.mode}`);
  if (r.packages.includes('packages/db')) throw new Error('db selected for a web page change');
});

check('lockfile change reruns everything', () => {
  if (run('pnpm-lock.yaml').mode !== 'all') throw new Error('lockfile did not escalate');
});

check('any package.json reruns everything', () => {
  if (run('apps/channels/package.json').mode !== 'all') throw new Error('manifest did not escalate');
});

check('ci script change reruns everything', () => {
  if (run('scripts/ci/shard.mjs').mode !== 'all') throw new Error('ci script did not escalate');
});

check('a file outside any package reruns everything', () => {
  if (run('README.md').mode !== 'all') throw new Error('root file did not escalate');
});

if (failures > 0) {
  console.error(`\n${failures} selector fixture(s) failed`);
  process.exit(1);
}
console.log('all selector fixtures pass');
