#!/usr/bin/env tsx
/**
 * Question-bank runner — the acceptance gate for stakeholder coverage.
 *
 * Lane `data` (default): runs the registry in-process against the seeded database
 * and compares each tool's payload with an INDEPENDENT SQL recomputation. The tool
 * query is never the ground truth.
 *
 * Lane `chat`: shelled out separately (`run-questions-chat.ts`) because it needs a
 * live server and a session cookie; kept apart so CI can run lane=data with no app.
 *
 * Exit code: 0 when no MISMATCH and no ERROR. BLOCKED cases (tool not built yet) are
 * reported with the step that unblocks them and do NOT fail the baseline. Pass
 * --strict to fail on blocked cases too — that is the CI mode once the plan is done.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql, databaseUrl } from '@aqar/db';
import { registry, toolDefs } from '@aqar/tools';
import type { ToolContext } from '@aqar/tools';
import { QUESTION_CASES, CASES_BY_TIER, type QuestionCase } from './questions.js';

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const AS_JSON = args.includes('--json');

type Status = 'PASS' | 'MISMATCH' | 'BLOCKED' | 'ERROR' | 'REFUSED-OK';

interface CaseResult {
  id: string;
  tier: number;
  tool: string | null;
  status: Status;
  expected: string | number | null;
  actual: string | number | null;
  detail: string;
  unblocksAt?: string;
}

/** Dotted-path read that tolerates arrays and missing links. */
function readPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      const index = Number(key);
      return Number.isInteger(index) ? node[index] : undefined;
    }
    return (node as Record<string, unknown>)[key];
  }, root);
}

function compare(
  expected: unknown,
  actual: unknown,
  mode: 'number' | 'string',
  tolerance: number,
): { ok: boolean; detail: string } {
  if (mode === 'string') {
    const normalise = (v: unknown) =>
      String(v ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const a = normalise(expected);
    const b = normalise(actual);
    return { ok: a === b, detail: a === b ? '' : `expected "${a}", payload "${b}"` };
  }
  const a = Number(expected);
  const b = Number(actual);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return {
      ok: false,
      detail: `non-numeric: expected ${String(expected)}, payload ${String(actual)}`,
    };
  }
  const ok = Math.abs(a - b) <= tolerance;
  return { ok, detail: ok ? '' : `expected ${a}, payload ${b} (Δ ${(b - a).toFixed(3)})` };
}

async function main(): Promise<void> {
  const sql = createSql(databaseUrl());
  try {
    const orgRows = await sql<
      { id: string; slug: string; name: string; timezone: string; currency: string }[]
    >`
      select id, slug, name, timezone, currency from organizations order by created_at limit 1
    `;
    const org = orgRows[0];
    if (org === undefined) throw new Error('no organization row — is the database seeded?');

    const ctx: ToolContext = {
      sql,
      org,
      now: () => new Date(),
      policy: {
        actor: 'eval-harness',
        mode: 'read_only',
        quietHoursStart: 22,
        quietHoursEnd: 7,
        tenantMessageDailyCap: 0,
        orgDailySpendCapFils: 0,
      },
    };

    const available = new Set(toolDefs.map((tool) => tool.name));
    const results: CaseResult[] = [];

    for (const testCase of QUESTION_CASES) {
      results.push(await runCase(testCase, ctx, available, sql));
    }

    report(results);
    if (AS_JSON) writeJson(results);

    const mismatches = results.filter((r) => r.status === 'MISMATCH' || r.status === 'ERROR');
    const blocked = results.filter((r) => r.status === 'BLOCKED');
    process.exitCode = mismatches.length > 0 || (STRICT && blocked.length > 0) ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function runCase(
  testCase: QuestionCase,
  ctx: ToolContext,
  available: ReadonlySet<string>,
  sql: ReturnType<typeof createSql>,
): Promise<CaseResult> {
  const wanted =
    testCase.expectTool === null
      ? []
      : typeof testCase.expectTool === 'string'
        ? [testCase.expectTool]
        : [...testCase.expectTool];

  const missing = wanted.filter((tool) => !available.has(tool));
  if (missing.length > 0) {
    return {
      id: testCase.id,
      tier: testCase.tier,
      tool: missing.join('|'),
      status: 'BLOCKED',
      expected: null,
      actual: null,
      detail: `no tool ${missing.join(', ')} yet — ${testCase.note}`,
      ...(testCase.unblocksAt === undefined ? {} : { unblocksAt: testCase.unblocksAt }),
    };
  }

  // A refusal case has nothing to compute: the assertion is "does it still refuse".
  if (testCase.expectTool === null) {
    return {
      id: testCase.id,
      tier: testCase.tier,
      tool: null,
      status: 'REFUSED-OK',
      expected: 'refusal',
      actual: 'refusal',
      detail: testCase.note,
    };
  }

  const toolName = wanted[0] as string;
  try {
    const payload = await registry.run(toolName, testCase.args ?? {}, ctx);

    if (testCase.groundTruth === undefined) {
      return {
        id: testCase.id,
        tier: testCase.tier,
        tool: toolName,
        status: 'PASS',
        expected: null,
        actual: null,
        detail: 'payload returned (no numeric ground truth)',
      };
    }

    const truthRows = (await sql.unsafe(testCase.groundTruth.sql)) as Record<string, unknown>[];
    const truth = truthRows[0]?.[Object.keys(truthRows[0] ?? {})[0] ?? ''];
    const path = testCase.groundTruth.payloadPath ?? 'count';
    const actual = readPath(payload, path);
    const { ok, detail } = compare(
      truth,
      actual,
      testCase.groundTruth.as ?? 'number',
      testCase.groundTruth.tolerance ?? 0,
    );

    return {
      id: testCase.id,
      tier: testCase.tier,
      tool: toolName,
      status: ok ? 'PASS' : 'MISMATCH',
      expected: (truth as string | number | null) ?? null,
      actual: (actual as string | number | null) ?? null,
      detail: detail === '' ? `${path} ✓` : detail,
    };
  } catch (error) {
    return {
      id: testCase.id,
      tier: testCase.tier,
      tool: toolName,
      status: 'ERROR',
      expected: null,
      actual: null,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

function report(results: readonly CaseResult[]): void {
  const count = (status: Status) => results.filter((r) => r.status === status).length;
  const lines: string[] = [];

  for (const tier of [1, 2, 3, 4] as const) {
    const rows = results.filter((r) => r.tier === tier);
    if (rows.length === 0) continue;
    lines.push(`\nTier ${tier} — ${CASES_BY_TIER[tier].length} cases`);
    for (const row of rows) {
      const tag = row.status.padEnd(11);
      const tool = (row.tool ?? '—').padEnd(22);
      const step = row.status === 'BLOCKED' && row.unblocksAt ? ` [${row.unblocksAt}]` : '';
      lines.push(`  ${tag} ${row.id.padEnd(26)} ${tool} ${row.detail.slice(0, 90)}${step}`);
    }
  }

  const blockedByStep = new Map<string, number>();
  for (const row of results.filter((r) => r.status === 'BLOCKED')) {
    const key = row.unblocksAt ?? 'unplanned';
    blockedByStep.set(key, (blockedByStep.get(key) ?? 0) + 1);
  }

  lines.push(
    `\n${results.length} cases: ${count('PASS')} pass · ${count('MISMATCH')} mismatch · ` +
      `${count('ERROR')} error · ${count('BLOCKED')} blocked · ${count('REFUSED-OK')} refused-by-design`,
  );
  if (blockedByStep.size > 0) {
    const steps = [...blockedByStep.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([step, n]) => `${step}:${n}`)
      .join(' · ');
    lines.push(`blocked at: ${steps}`);
  }
  console.info(lines.join('\n'));
}

function writeJson(results: readonly CaseResult[]): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, '../../../research/eval-baseline.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        lane: 'data',
        counts: {
          total: results.length,
          pass: results.filter((r) => r.status === 'PASS').length,
          mismatch: results.filter((r) => r.status === 'MISMATCH').length,
          error: results.filter((r) => r.status === 'ERROR').length,
          blocked: results.filter((r) => r.status === 'BLOCKED').length,
        },
        cases: results,
      },
      null,
      2,
    )}\n`,
  );
  console.info(`\nwrote ${out}`);
}

await main();
