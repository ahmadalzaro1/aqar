import { describe, expect, it } from 'vitest';
import { HAZARD_SIGNALS } from './emergency.js';
import { JORDAN_EMERGENCY_NUMBER, SAFETY_INSTRUCTIONS, safetyInstructions } from './safety.js';

const LOCALES = ['ar', 'en'] as const;

describe('safetyInstructions', () => {
  it('renders numbered steps for every hazard in both locales', () => {
    for (const signal of HAZARD_SIGNALS) {
      for (const locale of LOCALES) {
        const text = safetyInstructions(signal.id, locale);
        expect(text.length).toBeGreaterThan(0);
        expect(text).toContain('1.');
        expect(text).toContain('2.');
      }
    }
  });

  it('always names the emergency number', () => {
    for (const signal of HAZARD_SIGNALS) {
      for (const locale of LOCALES) {
        expect(safetyInstructions(signal.id, locale)).toContain(JORDAN_EMERGENCY_NUMBER);
      }
    }
  });

  it('carries the human-review / not-legal-advice footer in both locales', () => {
    expect(safetyInstructions('gas_smell', 'en')).toMatch(/human review required/i);
    expect(safetyInstructions('gas_smell', 'en')).toMatch(/not legal or contractual advice/i);
    expect(safetyInstructions('gas_smell', 'ar')).toContain('المراجعة البشرية');
    expect(safetyInstructions('gas_smell', 'ar')).toContain('ليست استشارة قانونية');
  });

  it('gives gas-specific steps: no switches, ventilate, evacuate, call 911', () => {
    const en = safetyInstructions('gas_smell', 'en').toLowerCase();
    expect(en).toContain('electrical switch');
    expect(en).toContain('open windows');
    expect(en).toContain('get everyone out');
    expect(en).toContain('911');

    const ar = safetyInstructions('gas_smell', 'ar');
    expect(ar).toContain('مفتاح كهربائي');
    expect(ar).toContain('افتح النوافذ');
    expect(ar).toContain('أخرج جميع السكان');
  });

  it('tells a fire victim not to use the elevator', () => {
    expect(safetyInstructions('fire', 'en').toLowerCase()).toContain('do not use the elevator');
    expect(safetyInstructions('fire', 'ar')).toContain('المصعد');
  });

  it('tells an elevator-trapped tenant to stay inside', () => {
    expect(safetyInstructions('elevator_entrapment', 'en').toLowerCase()).toContain('stay inside');
    expect(safetyInstructions('elevator_entrapment', 'ar')).toContain('ابقَ داخل المصعد');
  });

  it('warns against indoor charcoal heating for no_heat', () => {
    expect(safetyInstructions('no_heat', 'en').toLowerCase()).toContain('carbon monoxide');
    expect(safetyInstructions('no_heat', 'ar')).toContain('أول أكسيد الكربون');
  });

  it('falls back to a generic 911 set for an unknown key instead of silence', () => {
    for (const locale of LOCALES) {
      const text = safetyInstructions('unknown_signal', locale);
      expect(text).toContain(JORDAN_EMERGENCY_NUMBER);
      expect(text).toMatch(locale === 'ar' ? /المراجعة البشرية/ : /human review required/i);
    }
  });

  it('is deterministic for the same key and locale', () => {
    expect(safetyInstructions('sewage', 'ar')).toBe(safetyInstructions('sewage', 'ar'));
  });

  it('has a catalogue entry for every hazard signal', () => {
    for (const signal of HAZARD_SIGNALS) {
      const entry = SAFETY_INSTRUCTIONS[signal.id];
      expect(entry.ar.length).toBeGreaterThanOrEqual(3);
      expect(entry.en.length).toBeGreaterThanOrEqual(3);
      expect(entry.ar.length).toBe(entry.en.length);
    }
  });
});
