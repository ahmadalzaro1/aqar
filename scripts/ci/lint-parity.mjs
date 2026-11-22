#!/usr/bin/env node
/**
 * Probation oracle: does oxlint still catch everything ESLint catches?
 *
 * ESLint is no longer a project dependency. This script runs it ad hoc at a
 * pinned version and diffs the finding sets. Any location ESLint reports that
 * oxlint does not is a regression in coverage, which fails the job. Run weekly
 * on main until 2026-12-05, then delete this file and the reference config.
 */
import { execFileSync } from 'node:child_process';

const ESLINT = process.env.ESLINT_REF || 'eslint@9.39.1';

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseEslint(json) {
  const report = JSON.parse(json);
  const out = new Map();
  for (const file of report) {
    for (const m of file.messages) {
      const key = `${file.filePath.replace(process.cwd() + '/', '')}:${m.line}:${m.ruleId}`;
      out.set(key, out.get(key) || 0 + 1);
    }
  }
  return out;
}

function parseOxlint(json) {
  const report = JSON.parse(json);
  const items = report.diagnostics || report.results || [];
  const out = new Map();
  for (const d of items) {
    const msgs = d.messages || (d.code ? [d] : []);
    for (const m of msgs) {
      const file = (d.filePath || d.filename || '').replace(process.cwd() + '/', '');
      const rule = (m.ruleId || d.code || '')
        .replace(/^eslint\(/, '')
        .replace(/\)$/, '')
        .replace(/^@typescript-eslint\//, '');
      const line = m.line || d.labels?.[0]?.span?.line || 0;
      out.set(`${file}:${line}:${rule}`, true);
    }
  }
  return out;
}

const eslintJson = run('npx', [
  '--yes',
  '-p',
  ESLINT,
  '-p',
  'typescript-eslint@8.46.4',
  '-p',
  '@eslint/js@9.39.1',
  '-p',
  'globals@16.5.0',
  'eslint',
  '-c',
  'scripts/ci/eslint-reference.config.mjs',
  '.',
  '-f',
  'json',
]);
const oxlintJson = run('node_modules/.bin/oxlint', ['--format=json']);

const eslintFindings = parseEslint(eslintJson);
const oxlintFindings = parseOxlint(oxlintJson);

const missed = [...eslintFindings.keys()].filter((k) => !oxlintFindings.has(k));
console.log(`eslint findings: ${eslintFindings.size}   oxlint findings: ${oxlintFindings.size}`);
if (missed.length > 0) {
  console.error(
    `\nCOVERAGE REGRESSION — oxlint misses ${missed.length} finding(s) eslint reports:`,
  );
  for (const m of missed.slice(0, 40)) console.error('  ' + m);
  process.exit(1);
}
console.log('parity holds: every eslint finding is also reported by oxlint');
