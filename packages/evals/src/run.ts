// Eval runner for the Aqar emergency-triage pipeline.
//
// Two lanes:
//   deterministic — `emergencyPrecheck` only. NEVER needs a model, so it runs in
//                   CI and on a laptop with no network. This is the LAW-2 floor.
//   model         — full `runTriage` against the configured OpenAI-compatible
//                   provider. Gated behind AQAR_LIVE_MODEL=1 so a normal test run
//                   can never depend on a live server.
//
// The hard gate is LAW-2 recall: every case whose ground truth is an emergency
// MUST be predicted as one. A single miss exits non-zero. False positives are
// measured and printed, never hidden.
//
// CLI: tsx src/run.ts --lane deterministic|model

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emergencyPrecheck, hazardSignalCategory } from '@aqar/core';
import { providersFromEnv, runTriage, type AgentContext, type TriageInput } from '@aqar/agents';
import type { TicketCategory } from '@aqar/contracts';
import { GOLDEN_CASES, KNOWN_COVERAGE_GAPS, type GoldenCase, type GoldenKind } from './dataset.js';

export type Lane = 'deterministic' | 'model';

export interface CaseResult {
  readonly id: string;
  readonly text: string;
  readonly locale: 'ar' | 'en';
  readonly kind: GoldenKind;
  readonly expectEmergency: boolean;
  readonly expectedCategory: TicketCategory | null;
  readonly predictedEmergency: boolean;
  readonly predictedCategory: TicketCategory | null;
  readonly deterministicEmergency: boolean;
  readonly deterministicSignals: readonly string[];
  readonly modelEmergencyFlag: boolean | null;
  readonly modelCategory: TicketCategory | null;
  readonly modelUsed: string | null;
  readonly handedOffToHuman: boolean | null;
  /** True when the pipeline degraded (schema/provider) even if the verdict matched. */
  readonly degraded: boolean;
  readonly degradation: string | null;
  readonly latencyMs: number;
  readonly tokens: number;
  /** True when the verdict (emergency + category) matches ground truth. */
  readonly ok: boolean;
  readonly failure: string | null;
}

export interface LaneMetrics {
  readonly totalCases: number;
  readonly positives: number;
  readonly negatives: number;
  readonly truePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly falsePositives: number;
  readonly emergencyRecall: number;
  /** Negatives inside the benign+trap slice (the FP denominator). */
  readonly benignTrapNegatives: number;
  readonly benignTrapFalsePositives: number;
  readonly falsePositiveRate: number;
  readonly categoryEvaluated: number;
  readonly categoryCorrect: number;
  readonly categoryAccuracy: number | null;
  /** Model lane only: raw model category vs ground truth (before the LAW-2 override). */
  readonly modelCategoryEvaluated: number;
  readonly modelCategoryCorrect: number;
  readonly modelCategoryAccuracy: number | null;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly latencyMaxMs: number;
  readonly totalLatencyMs: number;
  readonly totalTokens: number;
  readonly handedOffCases: number;
  readonly degradedCases: number;
}

export interface ProviderInfo {
  readonly localBaseUrl: string;
  readonly localModel: string;
  readonly strongModel: string | null;
}

export interface LaneReport {
  readonly lane: Lane;
  readonly generatedAtISO: string;
  /** Null in the deterministic lane: it never touches a provider. */
  readonly provider: ProviderInfo | null;
  readonly metrics: LaneMetrics;
  readonly gate: { readonly name: string; readonly passed: boolean };
  readonly cases: readonly CaseResult[];
  readonly knownCoverageGaps: readonly {
    readonly text: string;
    readonly locale: 'ar' | 'en';
    readonly description: string;
    readonly flaggedToday: boolean;
  }[];
}

const ROUND_MS = 3;
const ROUND_RATE = 6;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Nearest-rank percentile on a sorted ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

function categoryFromSignals(signals: readonly string[]): TicketCategory | null {
  const first = signals[0];
  if (first === undefined) return null;
  return hazardSignalCategory(first) ?? null;
}

/**
 * Case latency: mean of 20 timed invocations after one warm-up pass.
 * The precheck is pure string work, so a single reading is mostly timer noise;
 * averaging keeps the reported number honest instead of pretending precision.
 */
const TIMED_REPETITIONS = 20;

function timePrecheckMs(text: string): number {
  let totalNs = 0n;
  for (let i = 0; i < TIMED_REPETITIONS; i += 1) {
    const started = process.hrtime.bigint();
    emergencyPrecheck(text);
    totalNs += process.hrtime.bigint() - started;
  }
  return Number(totalNs) / TIMED_REPETITIONS / 1_000_000;
}

function describeFailure(c: CaseResult): string | null {
  const parts: string[] = [];
  if (c.expectEmergency && !c.predictedEmergency) parts.push('FALSE NEGATIVE: hazard missed');
  if (!c.expectEmergency && c.predictedEmergency) parts.push('false positive: benign traffic flagged');
  if (c.expectedCategory !== null && c.predictedCategory !== c.expectedCategory) {
    parts.push(`category: expected ${c.expectedCategory}, got ${c.predictedCategory ?? 'none'}`);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

export function runDeterministicLane(cases: readonly GoldenCase[] = GOLDEN_CASES): CaseResult[] {
  // Warm-up so the first case is not charged for module-level regex construction.
  for (const c of cases) emergencyPrecheck(c.text);

  return cases.map((c) => {
    const pre = emergencyPrecheck(c.text);
    const predictedCategory = pre.emergency ? categoryFromSignals(pre.signals) : null;
    const base: CaseResult = {
      id: c.id,
      text: c.text,
      locale: c.locale,
      kind: c.kind,
      expectEmergency: c.expectEmergency,
      expectedCategory: c.expectCategory ?? null,
      predictedEmergency: pre.emergency,
      predictedCategory,
      deterministicEmergency: pre.emergency,
      deterministicSignals: pre.signals,
      modelEmergencyFlag: null,
      modelCategory: null,
      modelUsed: null,
      handedOffToHuman: null,
      degraded: false,
      degradation: null,
      latencyMs: round(timePrecheckMs(c.text), ROUND_MS),
      tokens: 0,
      ok: false,
      failure: null,
    };
    const withFailure: CaseResult = { ...base, failure: describeFailure(base) };
    return { ...withFailure, ok: withFailure.failure === null };
  });
}

function policyBaseForEval(): TriageInput['policyBase'] {
  return {
    orgId: 'org_eval',
    propertyId: 'prop_eval',
    actor: 'eval-runner',
    mode: 'dry_run',
    vendorId: null,
    vendorOnAllowList: false,
    nteLimitFils: null,
    approvalRequiredN: 1,
    approvalRequiredM: 1,
    approvalVotesYes: 0,
    localHour: 14,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    tenantMessagesToday: 0,
    tenantMessageDailyCap: 10,
    orgSpendTodayFils: 0,
    orgDailySpendCapFils: 500_000,
    humanApprovalTokenPresent: false,
  };
}

export interface ModelLaneOptions {
  readonly nowISO?: string;
  readonly tokenBudget?: number;
  readonly onProgress?: (done: number, total: number, id: string) => void;
}

export async function runModelLane(
  cases: readonly GoldenCase[] = GOLDEN_CASES,
  options: ModelLaneOptions = {},
): Promise<{ results: CaseResult[]; providers: ProviderInfo }> {
  const providers = providersFromEnv(process.env);
  const nowISO = options.nowISO ?? new Date().toISOString();
  const tokenBudget = options.tokenBudget ?? 100_000;
  const policyBase = policyBaseForEval();
  const results: CaseResult[] = [];

  let done = 0;
  for (const c of cases) {
    // The deterministic layer runs inside runTriage as step 1; capture it here
    // too so a miss can be attributed to the floor rather than the model.
    const pre = emergencyPrecheck(c.text);
    const ctx: AgentContext = {
      orgId: 'org_eval',
      propertyId: 'prop_eval',
      actor: 'eval-runner',
      locale: c.locale,
      nowISO,
      provider: providers.local,
      strongProvider: providers.strong,
      tokenBudget,
    };

    let predictedEmergency = pre.emergency;
    let predictedCategory: TicketCategory | null = null;
    let modelEmergencyFlag: boolean | null = null;
    let modelCategory: TicketCategory | null = null;
    let modelUsed: string | null = null;
    let handedOff: boolean | null = null;
    let latencyMs = 0;
    let tokens = 0;
    let pipelineError: string | null = null;

    try {
      const triage = await runTriage(
        {
          ticketId: `eval-${c.id}`,
          text: c.text,
          locale: c.locale,
          priorEmergency: false,
          policyBase,
        },
        ctx,
      );
      predictedEmergency = triage.merged.emergencyFlag;
      predictedCategory = triage.merged.category;
      modelEmergencyFlag = triage.merged.modelEmergencyFlag;
      modelCategory = triage.merged.category;
      latencyMs = triage.totalLatencyMs;
      tokens = triage.tokensUsed;
      handedOff = triage.handedOffToHuman;
      const classifyStep = triage.steps.find((s) => s.step === 'classify' && s.ok);
      modelUsed = classifyStep?.model ?? null;
      if (modelUsed === null) {
        pipelineError = triage.handoffReason ?? 'model classification unavailable';
      }
    } catch (err) {
      // runTriage is designed to degrade to the deterministic floor, so a throw
      // here is a real pipeline bug; record it, keep the deterministic verdict.
      pipelineError = `runTriage threw: ${err instanceof Error ? err.message : String(err)}`;
      predictedCategory = pre.emergency ? categoryFromSignals(pre.signals) : null;
    }

    const base: CaseResult = {
      id: c.id,
      text: c.text,
      locale: c.locale,
      kind: c.kind,
      expectEmergency: c.expectEmergency,
      expectedCategory: c.expectCategory ?? null,
      predictedEmergency,
      predictedCategory,
      deterministicEmergency: pre.emergency,
      deterministicSignals: pre.signals,
      modelEmergencyFlag,
      modelCategory,
      modelUsed,
      handedOffToHuman: handedOff,
      degraded: pipelineError !== null,
      degradation: pipelineError,
      latencyMs: round(latencyMs, ROUND_MS),
      tokens,
      ok: false,
      failure: null,
    };
    // `ok` is about the VERDICT; a schema/provider fallback is reported
    // separately as a degradation so a correct fallback verdict is not
    // mislabelled as an eval failure.
    const failure = describeFailure(base);
    results.push({ ...base, failure, ok: failure === null });
    done += 1;
    options.onProgress?.(done, cases.length, c.id);
  }

  return {
    results,
    providers: {
      localBaseUrl: providers.local.id,
      localModel: providers.local.model,
      strongModel: providers.strong?.model ?? null,
    },
  };
}

export function computeMetrics(results: readonly CaseResult[]): LaneMetrics {
  const positives = results.filter((r) => r.expectEmergency);
  const negatives = results.filter((r) => !r.expectEmergency);
  const truePositives = positives.filter((r) => r.predictedEmergency).length;
  const falseNegatives = positives.length - truePositives;
  const trueNegatives = negatives.filter((r) => !r.predictedEmergency).length;
  const falsePositives = negatives.length - trueNegatives;

  // Spec: false-positive rate is measured on the benign+trap slice only.
  const benignTrapNegatives = results.filter(
    (r) => (r.kind === 'benign' || r.kind === 'trap') && !r.expectEmergency,
  );
  const benignTrapFalsePositives = benignTrapNegatives.filter((r) => r.predictedEmergency).length;

  const categoryCases = results.filter((r) => r.expectedCategory !== null);
  const categoryCorrect = categoryCases.filter((r) => r.predictedCategory === r.expectedCategory).length;

  // Model lane diagnostic: the raw model category, before the deterministic
  // hazard override can mask it. Null offline (no model output at all).
  const modelCategoryCases = categoryCases.filter((r) => r.modelCategory !== null);
  const modelCategoryCorrect = modelCategoryCases.filter((r) => r.modelCategory === r.expectedCategory).length;

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalLatencyMs = results.reduce((sum, r) => sum + r.latencyMs, 0);
  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);

  return {
    totalCases: results.length,
    positives: positives.length,
    negatives: negatives.length,
    truePositives,
    falseNegatives,
    trueNegatives,
    falsePositives,
    emergencyRecall: positives.length === 0 ? 0 : round(truePositives / positives.length, ROUND_RATE),
    benignTrapNegatives: benignTrapNegatives.length,
    benignTrapFalsePositives,
    falsePositiveRate:
      benignTrapNegatives.length === 0
        ? 0
        : round(benignTrapFalsePositives / benignTrapNegatives.length, ROUND_RATE),
    categoryEvaluated: categoryCases.length,
    categoryCorrect,
    categoryAccuracy:
      categoryCases.length === 0 ? null : round(categoryCorrect / categoryCases.length, ROUND_RATE),
    modelCategoryEvaluated: modelCategoryCases.length,
    modelCategoryCorrect,
    modelCategoryAccuracy:
      modelCategoryCases.length === 0
        ? null
        : round(modelCategoryCorrect / modelCategoryCases.length, ROUND_RATE),
    latencyP50Ms: round(percentile(latencies, 50), ROUND_MS),
    latencyP95Ms: round(percentile(latencies, 95), ROUND_MS),
    latencyMaxMs: round(latencies[latencies.length - 1] ?? 0, ROUND_MS),
    totalLatencyMs: round(totalLatencyMs, ROUND_MS),
    totalTokens,
    handedOffCases: results.filter((r) => r.handedOffToHuman === true).length,
    degradedCases: results.filter((r) => r.degraded).length,
  };
}

/** LAW-2 hard gate: deterministically derived recall must be perfect. */
export function gatePassed(metrics: LaneMetrics): boolean {
  return metrics.emergencyRecall === 1;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** Flatten a value into one markdown-table cell: no newlines, no unescaped pipes. */
function cell(value: string): string {
  const flattened = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flattened.length > 180 ? `${flattened.slice(0, 177)}...` : flattened;
}

function coverageTable(): string {
  const kinds: GoldenKind[] = ['hazard', 'benign', 'adversarial', 'negation', 'trap'];
  const rows: string[] = ['| Kind | ar | en | total |', '| --- | ---: | ---: | ---: |'];
  for (const kind of kinds) {
    const subset = GOLDEN_CASES.filter((c) => c.kind === kind);
    const ar = subset.filter((c) => c.locale === 'ar').length;
    const en = subset.filter((c) => c.locale === 'en').length;
    rows.push(`| ${kind} | ${ar} | ${en} | ${subset.length} |`);
  }
  const arAll = GOLDEN_CASES.filter((c) => c.locale === 'ar').length;
  rows.push(`| **all** | **${arAll}** | **${GOLDEN_CASES.length - arAll}** | **${GOLDEN_CASES.length}** |`);
  return rows.join('\n');
}

export function renderMarkdown(report: LaneReport): string {
  const m = report.metrics;
  const gateMark = report.gate.passed ? 'PASS' : 'FAIL';
  const lines: string[] = [];

  lines.push(`## Aqar emergency-triage evals — \`${report.lane}\` lane`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAtISO}`);
  if (report.provider !== null) {
    lines.push(
      `Provider: \`${report.provider.localBaseUrl}\` (model \`${report.provider.localModel}\`, ` +
        `strong model ${report.provider.strongModel === null ? 'none' : `\`${report.provider.strongModel}\``})`,
    );
  }
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Cases | ${m.totalCases} |`);
  lines.push(`| Emergency cases (expect=true) | ${m.positives} |`);
  lines.push(`| **Emergency recall (LAW-2 gate)** | **${m.emergencyRecall.toFixed(4)} (${gateMark})** |`);
  lines.push(`| Missed emergencies (FN) | ${m.falseNegatives} |`);
  lines.push(`| Benign+trap false positives | ${m.benignTrapFalsePositives} / ${m.benignTrapNegatives} |`);
  lines.push(`| False-positive rate (benign+trap) | ${m.falsePositiveRate.toFixed(4)} |`);
  lines.push(
    `| Category accuracy | ${
      m.categoryAccuracy === null
        ? 'n/a'
        : `${m.categoryCorrect}/${m.categoryEvaluated} (${m.categoryAccuracy.toFixed(4)})`
    } |`,
  );
  lines.push(`| Latency p50 / p95 | ${m.latencyP50Ms.toFixed(3)} ms / ${m.latencyP95Ms.toFixed(3)} ms |`);
  lines.push(`| Total tokens | ${m.totalTokens} |`);
  if (report.lane === 'model') {
    lines.push(`| Cases handed off to a human | ${m.handedOffCases} |`);
    lines.push(`| Pipeline degradations (schema/provider fallback) | ${m.degradedCases} |`);
    lines.push(
      `| Raw model category accuracy (before LAW-2 override) | ${
        m.modelCategoryAccuracy === null
          ? 'n/a'
          : `${m.modelCategoryCorrect}/${m.modelCategoryEvaluated} (${m.modelCategoryAccuracy.toFixed(4)})`
      } |`,
    );
  }
  lines.push('');
  lines.push(`### Coverage (${GOLDEN_CASES.length} golden cases)`);
  lines.push('');
  lines.push(coverageTable());
  lines.push('');

  const failures = report.cases.filter((c) => !c.ok);
  lines.push('### Failures');
  lines.push('');
  if (failures.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Case | Kind | Expected | Predicted | Signals | Detail |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of failures) {
      lines.push(
        `| ${cell(f.id)} | ${f.kind} | ${String(f.expectEmergency)}/${f.expectedCategory ?? '-'} | ` +
          `${String(f.predictedEmergency)}/${f.predictedCategory ?? '-'} | ` +
          `${cell(f.deterministicSignals.join(',') || '-')} | ${cell(f.failure ?? '-')} |`,
      );
    }
  }
  lines.push('');

  const degradations = report.cases.filter((c) => c.degraded);
  if (degradations.length > 0) {
    lines.push('### Pipeline degradations (verdict may still be correct)');
    lines.push('');
    lines.push('| Case | Signs | Degradation |');
    lines.push('| --- | --- | --- |');
    for (const d of degradations) {
      lines.push(
        `| ${cell(d.id)} | ${cell(d.deterministicSignals.join(',') || '-')} | ${cell(d.degradation ?? '-')} |`,
      );
    }
    lines.push('');
  }

  const conservative = report.cases.filter(
    (c) => c.kind === 'trap' && c.expectEmergency && c.predictedEmergency,
  );
  if (conservative.length > 0) {
    lines.push('### Conservative over-flags, encoded as expected');
    lines.push('');
    lines.push('| Case | Signals | Why it is accepted |');
    lines.push('| --- | --- | --- |');
    for (const c of conservative) {
      lines.push(`| ${c.id} | ${c.deterministicSignals.join(',')} | Documented safety bias: cheap false positive over a missed hazard. |`);
    }
    lines.push('');
  }

  const missedGaps = report.knownCoverageGaps.filter((g) => !g.flaggedToday);
  // Always render the section: "no known gaps" is itself a reportable state.
  lines.push('### Known coverage gaps (not in the gate)');
  lines.push('');
  if (missedGaps.length > 0) {
    lines.push('| Locale | Text | Why it is missed |');
    lines.push('| --- | --- | --- |');
    for (const g of missedGaps) {
      lines.push(`| ${g.locale} | ${g.text} | ${g.description} |`);
    }
    lines.push('');
    lines.push(
      'These are real hazard phrasings the deterministic catalogue does not match. ' +
        'Fixing them is a `packages/core` change (reported upward), so they are excluded from the recall gate rather than weakening it.',
    );
  } else {
    lines.push(
      'None known. Previously documented gaps were closed in `packages/core` and promoted into the golden set, where they now count toward the recall gate.',
    );
  }
  lines.push('');

  const fpRate = m.falsePositiveRate;
  lines.push(
    `Summary: recall ${m.emergencyRecall.toFixed(4)} (${m.falseNegatives} miss${m.falseNegatives === 1 ? '' : 'es'}), ` +
      `false-positive rate ${formatPercent(fpRate)} on benign+trap traffic.`,
  );
  return lines.join('\n');
}

export function buildReport(
  lane: Lane,
  results: readonly CaseResult[],
  generatedAtISO = new Date().toISOString(),
  provider: ProviderInfo | null = null,
): LaneReport {
  const metrics = computeMetrics(results);
  return {
    lane,
    generatedAtISO,
    provider,
    metrics,
    gate: { name: 'emergencyRecall === 1.0 (LAW 2)', passed: gatePassed(metrics) },
    cases: results,
    knownCoverageGaps: KNOWN_COVERAGE_GAPS.map((g) => ({
      text: g.text,
      locale: g.locale,
      description: g.description,
      flaggedToday: emergencyPrecheck(g.text).emergency,
    })),
  };
}

function parseLane(argv: readonly string[]): Lane {
  const index = argv.indexOf('--lane');
  const value = index === -1 ? 'deterministic' : argv[index + 1];
  if (value === 'deterministic' || value === 'model') return value;
  throw new Error(`unknown --lane value: ${String(value)} (expected deterministic|model)`);
}

function resultsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
}

async function main(argv: readonly string[]): Promise<number> {
  const lane = parseLane(argv);
  if (lane === 'model' && process.env['AQAR_LIVE_MODEL'] !== '1') {
    process.stderr.write(
      'model lane is gated: set AQAR_LIVE_MODEL=1 and point LOCAL_BASE_URL at an OpenAI-compatible server.\n',
    );
    return 2;
  }

  const generatedAtISO = new Date().toISOString();
  let results: CaseResult[];
  let providerInfo: ProviderInfo | null = null;
  if (lane === 'deterministic') {
    results = runDeterministicLane();
  } else {
    const model = await runModelLane(GOLDEN_CASES, {
      nowISO: generatedAtISO,
      tokenBudget: 100_000,
      onProgress: (done, total, id) => process.stderr.write(`[model] ${done}/${total} ${id}\n`),
    });
    results = model.results;
    providerInfo = model.providers;
  }

  const report = buildReport(lane, results, generatedAtISO, providerInfo);
  const markdown = renderMarkdown(report);
  const isoFile = generatedAtISO.replace(/[:.]/g, '-');
  const dir = resultsDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${lane}-${isoFile}.json`);
  await writeFile(file, `${JSON.stringify({ ...report, markdown }, null, 2)}\n`, 'utf8');

  process.stdout.write(`${markdown}\n\nResults written to ${file}\n`);
  if (!report.gate.passed) {
    process.stderr.write(
      `LAW-2 GATE FAILED: emergency recall ${report.metrics.emergencyRecall} (${report.metrics.falseNegatives} missed).\n`,
    );
    return 1;
  }
  return 0;
}

const invokedPath = process.argv[1];
const isDirectRun =
  invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
