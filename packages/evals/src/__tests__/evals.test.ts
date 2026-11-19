import { describe, expect, it } from 'vitest';
import { emergencyPrecheck } from '@aqar/core';
import { ticketCategorySchema } from '@aqar/contracts';
import { GOLDEN_CASES, KNOWN_COVERAGE_GAPS, REQUIRED_SIGNALS } from '../dataset.js';
import {
  buildReport,
  computeMetrics,
  gatePassed,
  renderMarkdown,
  runDeterministicLane,
  type CaseResult,
} from '../run.js';

const results = runDeterministicLane();
const byId = new Map(results.map((r) => [r.id, r]));

function resultFor(id: string): CaseResult {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`missing result for case ${id}`);
  return found;
}

describe('dataset integrity', () => {
  it('has at least 40 golden cases', () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it('has unique ids and non-empty text/locale/kind', () => {
    const ids = new Set(GOLDEN_CASES.map((c) => c.id));
    expect(ids.size).toBe(GOLDEN_CASES.length);
    for (const c of GOLDEN_CASES) {
      expect(c.text.trim().length).toBeGreaterThan(0);
      expect(['ar', 'en']).toContain(c.locale);
      expect(['hazard', 'benign', 'adversarial', 'negation', 'trap']).toContain(c.kind);
      expect(c.note.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers both locales with a meaningful share each', () => {
    const ar = GOLDEN_CASES.filter((c) => c.locale === 'ar').length;
    const en = GOLDEN_CASES.filter((c) => c.locale === 'en').length;
    expect(ar).toBeGreaterThanOrEqual(15);
    expect(en).toBeGreaterThanOrEqual(15);
    expect(ar + en).toBe(GOLDEN_CASES.length);
  });

  it('meets the minimum counts per kind', () => {
    const count = (kind: string): number => GOLDEN_CASES.filter((c) => c.kind === kind).length;
    expect(count('hazard')).toBeGreaterThanOrEqual(24);
    expect(count('benign')).toBeGreaterThanOrEqual(10);
    expect(count('adversarial') + count('negation') + count('trap')).toBeGreaterThanOrEqual(12);
    expect(count('adversarial') + count('trap')).toBeGreaterThanOrEqual(6);
  });

  it('has only valid ticket categories in expectCategory', () => {
    for (const c of GOLDEN_CASES) {
      if (c.expectCategory === undefined) continue;
      const parsed = ticketCategorySchema.safeParse(c.expectCategory);
      expect(parsed.success, `${c.id} has invalid category ${String(c.expectCategory)}`).toBe(true);
    }
  });

  it('exercises all 12 hazard signals in BOTH Arabic and English', () => {
    for (const locale of ['ar', 'en'] as const) {
      const covered = new Set<string>();
      for (const c of GOLDEN_CASES) {
        if (c.locale !== locale) continue;
        for (const signal of emergencyPrecheck(c.text).signals) covered.add(signal);
      }
      for (const required of REQUIRED_SIGNALS) {
        expect(covered.has(required), `${locale} dataset does not cover signal ${required}`).toBe(true);
      }
    }
  });
});

describe('deterministic lane (LAW-2 floor)', () => {
  it('returns one result per case', () => {
    expect(results.length).toBe(GOLDEN_CASES.length);
  });

  it('HARD GATE: emergency recall equals 1.0', () => {
    const metrics = computeMetrics(results);
    expect(metrics.falseNegatives).toBe(0);
    expect(metrics.emergencyRecall).toBe(1);
    expect(gatePassed(metrics)).toBe(true);
  });

  it('flags every hazard case (all 12 signals in both locales)', () => {
    for (const c of GOLDEN_CASES.filter((x) => x.kind === 'hazard')) {
      const r = resultFor(c.id);
      expect(r.predictedEmergency, `${c.id} (${c.locale}) must be an emergency`).toBe(true);
      expect(r.deterministicSignals.length).toBeGreaterThan(0);
    }
  });

  it('keeps benign + trap negative false positives at the documented zero bound', () => {
    const metrics = computeMetrics(results);
    expect(metrics.benignTrapFalsePositives).toBe(0);
    expect(metrics.falsePositiveRate).toBe(0);
    for (const c of GOLDEN_CASES.filter((x) => (x.kind === 'benign' || x.kind === 'trap') && !x.expectEmergency)) {
      expect(resultFor(c.id).predictedEmergency, `${c.id} must stay quiet`).toBe(false);
    }
  });

  it('preserves the documented conservative over-flags instead of hiding them', () => {
    for (const c of GOLDEN_CASES.filter((x) => x.kind === 'trap' && x.expectEmergency)) {
      expect(c.note.toLowerCase()).toContain('conservative');
      const r = resultFor(c.id);
      expect(r.predictedEmergency, `${c.id} is expected to over-flag by design`).toBe(true);
      expect(r.ok).toBe(true);
    }
  });

  it('does not obey prompt injection with no hazard', () => {
    for (const id of ['adv-injection-en', 'adv-injection-ar', 'adv-injection-ar-2']) {
      expect(resultFor(id).predictedEmergency, `${id} must not invent an emergency`).toBe(false);
    }
  });

  it('keeps a real hazard flagged inside an injection', () => {
    const embedded = resultFor('adv-embedded-hazard');
    expect(embedded.predictedEmergency).toBe(true);
    expect(embedded.deterministicSignals).toContain('gas_smell');
    expect(embedded.predictedCategory).toBe('gas');
  });

  it('documents that negation does NOT clear a flag', () => {
    for (const c of GOLDEN_CASES.filter((x) => x.kind === 'negation')) {
      const r = resultFor(c.id);
      expect(r.predictedEmergency, `${c.id} should stay flagged under the conservative design`).toBe(true);
      expect(r.deterministicSignals.length).toBeGreaterThan(0);
    }
  });

  it('derives the merged hazard category from the first signal', () => {
    const metrics = computeMetrics(results);
    expect(metrics.categoryEvaluated).toBeGreaterThanOrEqual(24);
    expect(metrics.categoryCorrect).toBe(metrics.categoryEvaluated);
    expect(metrics.categoryAccuracy).toBe(1);
  });

  it('reports honest latency percentiles and zero tokens offline', () => {
    const metrics = computeMetrics(results);
    expect(metrics.latencyP50Ms).toBeGreaterThanOrEqual(0);
    expect(metrics.latencyP50Ms).toBeLessThanOrEqual(metrics.latencyP95Ms);
    expect(metrics.latencyP95Ms).toBeLessThanOrEqual(metrics.latencyMaxMs);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.degradedCases).toBe(0);
    expect(metrics.modelCategoryAccuracy).toBeNull();
  });
});

describe('gate behaviour', () => {
  it('fails when a single emergency is missed', () => {
    const metrics = computeMetrics(results);
    expect(gatePassed({ ...metrics, emergencyRecall: 0.96, falseNegatives: 1 })).toBe(false);
    expect(gatePassed({ ...metrics, emergencyRecall: 1 })).toBe(true);
  });
});

describe('known coverage gaps', () => {
  it('documents phrasings the deterministic catalogue currently misses', () => {
    for (const gap of KNOWN_COVERAGE_GAPS) {
      const flagged = emergencyPrecheck(gap.text).emergency;
      expect(
        flagged,
        `Core improved: "${gap.text}" is now flagged. Promote it from KNOWN_COVERAGE_GAPS into GOLDEN_CASES.`,
      ).toBe(false);
    }
  });
});

describe('report output', () => {
  it('builds a passing deterministic report with a markdown table', () => {
    const report = buildReport('deterministic', results, '2026-01-01T00:00:00.000Z');
    expect(report.gate.passed).toBe(true);
    expect(report.gate.name).toContain('LAW 2');
    expect(report.provider).toBeNull();
    expect(report.knownCoverageGaps.length).toBe(KNOWN_COVERAGE_GAPS.length);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain('Emergency recall (LAW-2 gate)');
    expect(markdown).toContain('| Cases |');
    expect(markdown).toContain('PASS');
    expect(markdown).toContain('Known coverage gaps');
    expect(markdown).not.toContain('| undefined |');
    expect(markdown).not.toContain('Pipeline degradations');

    const json = JSON.stringify({ ...report, markdown });
    expect(() => JSON.parse(json) as unknown).not.toThrow();
  });
});
