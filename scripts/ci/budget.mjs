#!/usr/bin/env node
/**
 * Fails a job that exceeded its own budget, measured inside the job.
 *
 * Deliberately self-contained: a separate "budget" job would have to wait for
 * the timed job, and a required job that waits on another lengthens the lane.
 *
 * Usage: node scripts/ci/budget.mjs --job static --budget 35 --start 1763767200
 */
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i === -1 ? d : args[i + 1];
};
const job = opt('--job', 'job');
const budget = Number(opt('--budget', '0'));
const start = Number(opt('--start', '0'));
if (!budget || !start) {
  console.error('budget.mjs: --budget and --start are required');
  process.exit(2);
}
const elapsed = Date.now() / 1000 - start;
const line = `${job}: ${elapsed.toFixed(1)}s / ${budget}s budget`;
if (elapsed > budget) {
  console.error(`OVER BUDGET — ${line}`);
  process.exit(1);
}
console.log(`within budget — ${line}`);
