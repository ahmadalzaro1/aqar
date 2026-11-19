// LAW 2 merge: deterministic emergency OR model emergency OR prior emergency.
//
// Rules, in order:
//   emergency  = precheck.emergency || model.emergencyFlag || priorEmergency
//   severity   = 'emergency' when emergency, else the model's severity
//   category   = model's category, except when an emergency-raising deterministic
//                signal implies a hazard category, which wins for the eight
//                hazard categories only
//
// A model may RAISE severity (e.g. 'low' -> 'emergency' via emergencyFlag) and may
// never LOWER an emergency flag. Once emergency, sticky for the ticket's life:
// callers pass the stored flag back in as `priorEmergency` on every later merge.

import type {
  Classification,
  EmergencyPrecheck,
  MergedClassification,
  TicketCategory,
} from '@aqar/contracts';
import { hazardSignalCategory } from './emergency.js';

/** Categories a deterministic hazard signal is allowed to override. */
const HAZARD_CATEGORIES: ReadonlySet<TicketCategory> = new Set<TicketCategory>([
  'gas',
  'fire',
  'sewage',
  'water',
  'electrical',
  'structural',
  'lock',
  'elevator',
]);

/**
 * Merge a deterministic pre-check, a model classification, and the stored
 * emergency flag into the record the ticket engine persists.
 */
export function mergeClassification(
  precheck: EmergencyPrecheck,
  model: Classification,
  priorEmergency = false,
): MergedClassification {
  const deterministicEmergency = precheck.emergency;
  const emergency = deterministicEmergency || model.emergencyFlag || priorEmergency;

  const overrideCategory = emergency ? hazardCategoryFromSignals(precheck.signals) : undefined;
  const category = overrideCategory ?? model.category;

  const signalsLabel = precheck.signals.length > 0 ? precheck.signals.join(',') : 'none';
  const deterministicNote =
    `[deterministic: precheck.emergency=${deterministicEmergency}, signals=${signalsLabel}, ` +
    `model.emergencyFlag=${model.emergencyFlag}, priorEmergency=${priorEmergency}; ` +
    `LAW 2: emergency is sticky and a model may raise but never lower it]`;

  return {
    category,
    severity: emergency ? 'emergency' : model.severity,
    emergencyFlag: emergency,
    confidence: model.confidence,
    rationale: `${model.rationale} ${deterministicNote}`.trim(),
    deterministicEmergency,
    modelSeverity: model.severity,
    modelEmergencyFlag: model.emergencyFlag,
  };
}

/** First signal (catalogue order) whose implied category is a hazard category. */
function hazardCategoryFromSignals(signals: readonly string[]): TicketCategory | undefined {
  for (const signal of signals) {
    const category = hazardSignalCategory(signal);
    if (category !== undefined && HAZARD_CATEGORIES.has(category)) return category;
  }
  return undefined;
}
