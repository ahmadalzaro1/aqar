#!/usr/bin/env node
/**
 * Time-balanced test shards, recorded from real runs.
 *
 * File counts are a bad proxy for work: on this repo one property test costs
 * 2.1s while forty unit files together cost less. So main records each file's
 * measured duration on every full run (--record), and PRs are split with those
 * numbers using longest-processing-time first.
 *
 *   node scripts/ci/shard.mjs --record <vitest.json> --package packages/core
 *   node scripts/ci/shard.mjs --package packages/core --shards 4 --index 2   # files for shard 3
 *   node scripts/ci/shard.mjs --package packages/core --shards 4 --verify     # union must equal all files
 *
 * --verify is the gate that keeps the split honest: it fails unless the shards
 * together contain every recorded file exactly once.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const FILE = '.ci/test-times.json';
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i === -1 ? d : args[i + 1];
};

const pkg = opt('--package', null);
const record = opt('--record', null);
const shards = Number(opt('--shards', '1'));
const index = opt('--index', null);
const verify = args.includes('--verify');

function load() {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
}

if (record) {
  if (!pkg) throw new Error('--record needs --package');
  const report = JSON.parse(readFileSync(record, 'utf8'));
  // store paths relative to the repo root: an absolute path recorded on one
  // machine is meaningless on the runner
  const rows = (report.testResults || []).map((t) => ({
    file: relative(process.cwd(), t.name),
    ms: Math.max(1, (t.endTime || 0) - (t.startTime || 0)),
  }));
  if (rows.length === 0) {
    console.error(`shard.mjs: ${record} recorded no test files; refusing to overwrite times`);
    process.exit(2);
  }
  const db = load();
  db[pkg] = rows.sort((a, b) => a.file.localeCompare(b.file));
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 1) + '\n');
  console.log(`recorded ${rows.length} file times for ${pkg}`);
  process.exit(0);
}

if (!pkg) throw new Error('--package is required');
const db = load();
const rows = db[pkg];
if (!rows || rows.length === 0) {
  console.error(
    `shard.mjs: no recorded times for ${pkg}; run a full main build with --record first`,
  );
  process.exit(2);
}

const total = rows.reduce((a, r) => a + r.ms, 0);
if (shards <= 1) {
  if (verify)
    console.log(`${pkg}: 1 shard covers all ${rows.length} files (${(total / 1000).toFixed(1)}s)`);
  if (index !== null) rows.forEach((r) => console.log(resolve(r.file)));
  process.exit(0);
}

// LPT: heaviest file first into the lightest shard that can take it.
const bins = Array.from({ length: shards }, () => ({ ms: 0, files: [] }));
for (const row of [...rows].sort((a, b) => b.ms - a.ms)) {
  const target = bins.reduce((min, b) => (b.ms < min.ms ? b : min), bins[0]);
  target.files.push(row.file);
  target.ms += row.ms;
}

if (verify) {
  const seen = bins.flatMap((b) => b.files);
  const unique = new Set(seen);
  const expected = new Set(rows.map((r) => r.file));
  const missing = [...expected].filter((f) => !unique.has(f));
  const extra = [...unique].filter((f) => !expected.has(f));
  const dupes = seen.length !== unique.size;
  console.log(`${pkg}: ${rows.length} files, ${(total / 1000).toFixed(1)}s total`);
  bins.forEach((b, i) =>
    console.log(`  shard ${i}: ${b.files.length} files, ${(b.ms / 1000).toFixed(1)}s`),
  );
  if (missing.length || extra.length || dupes) {
    console.error(
      `SHARD COVERAGE BROKEN: missing=${missing.length} extra=${extra.length} duplicates=${dupes}`,
    );
    process.exit(1);
  }
  if (seen.length !== rows.length) {
    console.error(
      `SHARD COVERAGE BROKEN: ${seen.length} files across shards, ${rows.length} recorded`,
    );
    process.exit(1);
  }
  console.log('  every recorded file appears exactly once');
  process.exit(0);
}

if (index === null) {
  bins.forEach((b, i) =>
    console.log(`shard ${i}: ${(b.ms / 1000).toFixed(1)}s / ${b.files.length} files`),
  );
  process.exit(0);
}
const bin = bins[Number(index)];
if (!bin) {
  console.error(`shard.mjs: no shard ${index} of ${shards}`);
  process.exit(2);
}
bin.files.forEach((f) => console.log(resolve(f)));
