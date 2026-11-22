#!/usr/bin/env node
// LAW 1 enforcement: packages/core must be PURE.
// Fails on: imports from packages/agents, any LLM SDK, ORM, node I/O modules,
// fetch/Date.now/Math.random usage in source, and non-allowlisted runtime deps.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const coreDir = join(root, 'packages/core');
const violations = [];

const ALLOWED_DEPS = new Set(['@aqar/contracts']);
const pkg = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8'));
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  if (!ALLOWED_DEPS.has(dep))
    violations.push(`package.json: runtime dependency not allowlisted: ${dep}`);
}

const FORBIDDEN_IMPORT = /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
const FORBIDDEN_PREFIXES = [
  '@aqar/agents',
  '@aqar/db',
  'openai',
  '@anthropic',
  'drizzle',
  'pg',
  'postgres',
  'bullmq',
  'ioredis',
  'node:fs',
  'node:http',
  'node:https',
  'node:net',
  'node:child_process',
  'fs',
  'http',
  'https',
  'net',
  'child_process',
  'axios',
  'node-fetch',
  'undici',
];
const FORBIDDEN_CALLS = [
  [/\bfetch\s*\(/, 'fetch() call'],
  [/\bDate\.now\s*\(/, 'Date.now() call'],
  [/\bnew\s+Date\s*\(\s*\)/, 'new Date() with no argument (wall-clock read)'],
  [/\bMath\.random\s*\(/, 'Math.random() call'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|mts|js|mjs)$/.test(name) || /\.test\./.test(name) || /\.property\./.test(name))
      continue;
    const src = readFileSync(p, 'utf8');
    const rel = relative(root, p);
    for (const m of src.matchAll(FORBIDDEN_IMPORT)) {
      const spec = m[1];
      if (FORBIDDEN_PREFIXES.some((f) => spec === f || spec.startsWith(f + '/'))) {
        violations.push(`${rel}: forbidden import '${spec}'`);
      }
    }
    for (const [re, label] of FORBIDDEN_CALLS) {
      if (re.test(src)) violations.push(`${rel}: ${label}`);
    }
  }
}
walk(join(coreDir, 'src'));

if (violations.length > 0) {
  console.error('LAW 1 VIOLATIONS (packages/core must be pure):');
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
console.log('LAW 1 dependency-rule check: PASS (packages/core is pure)');
