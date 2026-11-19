// Deterministic, multilingual (Arabic / English / Levantine) hazard pre-check.
// LAW 1: no LLM, no I/O, no clock — a rule catalogue over normalized text.
// LAW 2: this layer can only RAISE an emergency. It is never down-weighted by a
// model, and a flag it raises is sticky for the ticket's life.
//
// SAFETY BIAS (deliberate, documented):
//   Negation does NOT clear a flag. "no gas smell", "ما في ريحة غاز", "not on fire"
//   still raise. A false positive is reviewed by a human within minutes; a false
//   negative can kill someone. Where the two error costs are asymmetric, we take
//   the cheap error on purpose.
//
// Matching is phrase-level: a pattern matches only at a letter boundary, with the
// Arabic definite article (ال) optionally elided on the pattern side, so
// "التصدع" matches the pattern "تصدع" while "منارة" does not match "نار".

import type { EmergencyPrecheck, TicketCategory } from '@aqar/contracts';
import { normalizeText } from './normalize.js';

/** All hazard signal ids, in catalogue (evaluation) order. */
export type HazardSignalId =
  | 'gas_leak'
  | 'gas_smell'
  | 'fire'
  | 'smoke'
  | 'electrical_hazard'
  | 'sewage'
  | 'flooding'
  | 'no_water'
  | 'elevator_entrapment'
  | 'structural'
  | 'lock_failure'
  | 'no_heat';

export interface HazardSignal {
  readonly id: HazardSignalId;
  /** Ticket category this signal implies, used only to override a model category. */
  readonly category: TicketCategory;
  /** Human/pattern source phrases; normalized once at module load. */
  readonly patterns: readonly string[];
}

/**
 * Hazard catalogue. Order matters: the first matching signal becomes the
 * `safetyInstructionsKey`, so specific signals are listed before broad ones.
 * Coverage: MSA, Jordanian/Levantine dialect spellings, and English.
 */
export const HAZARD_SIGNALS: readonly HazardSignal[] = [
  {
    id: 'gas_leak',
    category: 'gas',
    patterns: ['تسرب غاز', 'تسرب الغاز', 'تسريب غاز', 'gas leak', 'leaking gas', 'gas leaking', 'leak of gas'],
  },
  {
    id: 'gas_smell',
    category: 'gas',
    patterns: [
      'غاز',
      'ريحة غاز',
      'ريحة الغاز',
      'رائحة غاز',
      'رايحة غاز',
      'ريحه غاز',
      'غاز بالمطبخ',
      'gas smell',
      'smell of gas',
      'smelling gas',
      'smells like gas',
      'gas',
    ],
  },
  {
    id: 'fire',
    category: 'fire',
    patterns: ['حريق', 'نار', 'لهب', 'انفجار', 'fire', 'flames', 'explosion', 'burning', 'on fire'],
  },
  {
    id: 'smoke',
    category: 'fire',
    patterns: ['دخان', 'smoke', 'smoking', 'smoke smell', 'smell of smoke'],
  },
  {
    id: 'electrical_hazard',
    category: 'electrical',
    patterns: [
      'شرر',
      'أسلاك مكشوفة',
      'اسلاك مكشوفه',
      'التماس',
      'صعقة',
      'صعقه',
      'كهرباء مكشوفة',
      'شرارة كهرباء',
      'spark',
      'sparks',
      'sparking',
      'exposed wire',
      'exposed wires',
      'exposed wiring',
      'electrical shock',
      'electric shock',
      'short circuit',
    ],
  },
  {
    id: 'sewage',
    category: 'sewage',
    patterns: ['مجاري', 'صرف صحي', 'طفح المجاري', 'sewage', 'sewage backup', 'sewer', 'raw sewage'],
  },
  {
    id: 'flooding',
    category: 'water',
    patterns: ['فيضان', 'تسرب مياه', 'تسرب الماء', 'انفجار انبوب', 'المياه تغرق', 'flooding', 'flood', 'burst pipe', 'water leak', 'pipe burst'],
  },
  {
    id: 'no_water',
    category: 'water',
    patterns: [
      'ما في مي',
      'مافي مي',
      'ما في ميه',
      'ما في مياه',
      'ما في ماء',
      'مافي ماء',
      'ما في مويه',
      'انقطاع المياه',
      'انقطاع الماء',
      'المياه مقطوعة',
      'no water',
      'water cut off',
      'water is cut off',
      'water outage',
      'without water',
    ],
  },
  {
    id: 'elevator_entrapment',
    category: 'elevator',
    patterns: ['محتجز بالمصعد', 'محتجز في المصعد', 'عالق بالمصعد', 'عالق في المصعد', 'trapped in elevator', 'trapped in the elevator', 'stuck in elevator', 'stuck in the elevator'],
  },
  {
    id: 'structural',
    category: 'structural',
    patterns: ['تصدع', 'انهيار', 'سقوط جدار', 'تشقق الجدران', 'crack', 'cracks', 'cracked', 'collapse', 'collapsed', 'structural', 'wall falling'],
  },
  {
    id: 'lock_failure',
    category: 'lock',
    patterns: ['قفل', 'مقفل', 'ما بقدر افتح', 'ما بقدر أفتح', 'لا استطيع فتح الباب', 'locked out', 'lock broken', 'lock is broken', 'door lock'],
  },
  {
    id: 'no_heat',
    category: 'hvac',
    patterns: ['ما في تدفئة', 'ما في تدفئه', 'تدفئة مقطوعة', 'بلا تدفئة', 'no heat', 'no heating', 'heating is off', 'freezing'],
  },
];

/** Signal id -> implied ticket category. */
const SIGNAL_CATEGORY: ReadonlyMap<string, TicketCategory> = new Map(
  HAZARD_SIGNALS.map((s) => [s.id as string, s.category] as const),
);

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Build a phrase matcher: letter-boundary on both sides, optional Arabic
 * definite article on the haystack side (ال + pattern).
 */
function phraseRegex(normalizedPattern: string): RegExp {
  const escaped = normalizedPattern.replace(REGEX_SPECIALS, '\\$&');
  return new RegExp(`(?<!\\p{L})(?:ال)?${escaped}(?!\\p{L})`, 'u');
}

/** Normalized patterns per signal id, built once at load (pure string ops). */
const NORMALIZED_PATTERNS: ReadonlyArray<{ id: HazardSignalId; regex: RegExp }> = HAZARD_SIGNALS.flatMap(
  (signal) =>
    signal.patterns.map((pattern) => ({
      id: signal.id,
      regex: phraseRegex(normalizeText(pattern)),
    })),
);

function matchesAny(normalizedText: string, regex: RegExp): boolean {
  return regex.test(normalizedText);
}

/**
 * Deterministic hazard pre-classification of a free-text ticket.
 *
 * `signals` lists every matched hazard id in catalogue order (deduplicated).
 * `safetyInstructionsKey` is the first matched signal id, null when not emergency.
 */
export function emergencyPrecheck(text: string): EmergencyPrecheck {
  const normalized = normalizeText(text);
  const signals: string[] = [];
  for (const { id, regex } of NORMALIZED_PATTERNS) {
    if (signals.includes(id)) continue;
    if (matchesAny(normalized, regex)) signals.push(id);
  }

  const first = signals.length > 0 ? signals[0] : undefined;
  const emergency = first !== undefined;
  return {
    emergency,
    signals,
    safetyInstructionsKey: emergency && first !== undefined ? first : null,
  };
}

/** Ticket category implied by a hazard signal id, undefined for unknown ids. */
export function hazardSignalCategory(signalId: string): TicketCategory | undefined {
  return SIGNAL_CATEGORY.get(signalId);
}
