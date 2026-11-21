#!/usr/bin/env node
/**
 * Which tests a diff can reach.
 *
 * Conservative by construction: anything that is not clearly owned by one
 * workspace package — lockfile, any package.json, turbo/tsconfig/vitest config,
 * CI scripts, this tool — reruns everything. Packages that depend on a changed
 * package are included, so a change to @aqar/contracts runs everyone who imports
 * it.
 *
 *   node scripts/ci/select-tests.mjs --base origin/main --head HEAD
 *
 * Output is JSON: { mode: 'all' | 'affected', packages: [...], reason }
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i === -1 ? d : args[i + 1];
};
const base = opt('--base', process.env.BASE_SHA || '');
const head = opt('--head', process.env.HEAD_SHA || 'HEAD');
const filesArg = opt('--files', null);

const RERUN_ALL = [
  /^pnpm-lock\.yaml$/,
  /(^|\/)package\.json$/,
  /^turbo\.json$/,
  /tsconfig.*\.json$/,
  /vitest.*config\./,
  /^\.github\//,
  /^scripts\//,
  /^\.ci\//,
  /^eslint\.config\./,
  /^\.oxlintrc\.json$/,
];

// GitHub's file command wants `key=value` lines, not JSON.
const githubOutput = args.includes('--github-output');
const emit = (payload) => {
  if (githubOutput) {
    console.log(`mode=${payload.mode}`);
    console.log(`packages=${(payload.packages || []).join(',')}`);
    console.log(`reason=${payload.reason}`);
    return;
  }
  console.log(JSON.stringify(payload));
};

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

if (!base && filesArg === null) {
  emit({ mode: 'all', packages: [], reason: 'no base sha (first push or force-push) — running everything' });
  process.exit(0);
}

let changed = [];
if (filesArg !== null) {
  // test hook: an explicit list lets the selector's own tests exercise it
  changed = filesArg.split(',').map((s) => s.trim()).filter(Boolean);
} else {
  try {
    changed = git(['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
  } catch {
    emit({ mode: 'all', packages: [], reason: 'cannot diff base..head — running everything' });
    process.exit(0);
  }
}

if (changed.length === 0) {
  emit({ mode: 'affected', packages: [], reason: 'no changed files' });
  process.exit(0);
}

const forced = changed.find((f) => RERUN_ALL.some((re) => re.test(f)));
if (forced) {
  emit({ mode: 'all', packages: [], reason: `shared input changed: ${forced}` });
  process.exit(0);
}

// workspace packages and their internal dependencies
const roots = ['packages', 'apps'];
const pkgDirs = [];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const name of execFileSync('ls', [root], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
    const dir = `${root}/${name}`;
    if (existsSync(`${dir}/package.json`)) pkgDirs.push(dir);
  }
}
const manifest = new Map();
for (const dir of pkgDirs) {
  const p = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  const deps = { ...p.dependencies, ...p.devDependencies };
  manifest.set(dir, { name: p.name, deps: Object.keys(deps).filter((d) => d.startsWith('@aqar/')) });
}
const nameToDir = new Map([...manifest].map(([dir, m]) => [m.name, dir]));

const touched = new Set();
for (const file of changed) {
  const dir = pkgDirs.filter((d) => file.startsWith(d + '/')).sort((a, b) => b.length - a.length)[0];
  if (!dir) {
    emit({ mode: 'all', packages: [], reason: `changed file outside any package: ${file}` });
    process.exit(0);
  }
  touched.add(dir);
}

// grow the set along reverse dependencies until stable
let grew = true;
while (grew) {
  grew = false;
  for (const [dir, m] of manifest) {
    if (touched.has(dir)) continue;
    if (m.deps.some((d) => touched.has(nameToDir.get(d)))) {
      touched.add(dir);
      grew = true;
    }
  }
}

emit({ mode: 'affected', packages: [...touched].sort(), changed: changed.length, reason: 'diff-reachable packages' });
