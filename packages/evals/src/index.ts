// @aqar/evals — offline bilingual golden-dataset harness for the emergency
// triage pipeline. The deterministic lane is the LAW-2 floor and must always be
// runnable with no model, no network and no clock.
export { GOLDEN_CASES, KNOWN_COVERAGE_GAPS, REQUIRED_SIGNALS } from './dataset.js';
export type { GoldenCase, GoldenKind, KnownCoverageGap } from './dataset.js';
export {
  buildReport,
  computeMetrics,
  gatePassed,
  renderMarkdown,
  runDeterministicLane,
  runModelLane,
} from './run.js';
export type { CaseResult, Lane, LaneMetrics, LaneReport, ModelLaneOptions, ProviderInfo } from './run.js';
