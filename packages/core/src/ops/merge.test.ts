import { describe, expect, it } from 'vitest';
import type { Classification } from '@aqar/contracts';
import { emergencyPrecheck } from './emergency.js';
import { mergeClassification } from './merge.js';

function model(overrides: Partial<Classification> = {}): Classification {
  return {
    category: 'other',
    severity: 'low',
    emergencyFlag: false,
    confidence: 0.5,
    rationale: 'model says nothing alarming',
    ...overrides,
  };
}

describe('mergeClassification — non-emergency path', () => {
  it('keeps the model severity and category when nothing raises an emergency', () => {
    const merged = mergeClassification(
      emergencyPrecheck('the tap drips'),
      model({ severity: 'medium', category: 'plumbing' }),
    );
    expect(merged.severity).toBe('medium');
    expect(merged.category).toBe('plumbing');
    expect(merged.emergencyFlag).toBe(false);
    expect(merged.deterministicEmergency).toBe(false);
  });

  it('records what each layer said', () => {
    const merged = mergeClassification(
      emergencyPrecheck('the tap drips'),
      model({ severity: 'low', emergencyFlag: false, confidence: 0.42 }),
    );
    expect(merged.modelSeverity).toBe('low');
    expect(merged.modelEmergencyFlag).toBe(false);
    expect(merged.deterministicEmergency).toBe(false);
    expect(merged.confidence).toBe(0.42);
  });

  it('preserves the model rationale and appends a deterministic note', () => {
    const merged = mergeClassification(
      emergencyPrecheck('the tap drips'),
      model({ rationale: 'minor drip' }),
    );
    expect(merged.rationale.startsWith('minor drip')).toBe(true);
    expect(merged.rationale).toContain('LAW 2');
    expect(merged.rationale).toContain('signals=none');
  });

  it('allows a cosmetic severity when no emergency exists', () => {
    const merged = mergeClassification(
      emergencyPrecheck('paint faded in the lobby'),
      model({ severity: 'cosmetic' }),
    );
    expect(merged.severity).toBe('cosmetic');
  });
});

describe('mergeClassification — a model may raise but never lower', () => {
  it('lets a model emergencyFlag raise a non-hazard ticket to emergency', () => {
    const merged = mergeClassification(
      emergencyPrecheck('the ceiling looks strange'),
      model({ severity: 'high', emergencyFlag: true, category: 'structural' }),
    );
    expect(merged.emergencyFlag).toBe(true);
    expect(merged.severity).toBe('emergency');
    expect(merged.deterministicEmergency).toBe(false);
    expect(merged.modelEmergencyFlag).toBe(true);
    expect(merged.modelSeverity).toBe('high');
  });
});

describe('mergeClassification — deterministic emergency wins', () => {
  it('overrides a cosmetic model severity and the model category on a gas smell', () => {
    const precheck = emergencyPrecheck('ريحة غاز قوية بالمطبخ');
    const merged = mergeClassification(
      precheck,
      model({ severity: 'cosmetic', category: 'other' }),
    );
    expect(merged.emergencyFlag).toBe(true);
    expect(merged.severity).toBe('emergency');
    expect(merged.category).toBe('gas');
    expect(merged.modelSeverity).toBe('cosmetic');
    expect(merged.deterministicEmergency).toBe(true);
  });

  it('overrides a low model severity on English "fire in the kitchen"', () => {
    const merged = mergeClassification(
      emergencyPrecheck('fire in the kitchen'),
      model({ severity: 'low' }),
    );
    expect(merged.severity).toBe('emergency');
    expect(merged.category).toBe('fire');
  });

  it('keeps the model category when the hazard signal has no overrideable category', () => {
    const precheck = emergencyPrecheck('ما في تدفئة');
    const merged = mergeClassification(precheck, model({ severity: 'low', category: 'other' }));
    expect(merged.emergencyFlag).toBe(true);
    expect(merged.severity).toBe('emergency');
    // 'no_heat' maps to hvac, which is not one of the eight hazard overrides
    expect(merged.category).toBe('other');
  });

  it('overrides to the category of the first overrideable signal', () => {
    const precheck = emergencyPrecheck('تسرب غاز وشرر من المقبس');
    const merged = mergeClassification(precheck, model({ category: 'plumbing' }));
    expect(precheck.signals.slice(0, 2)).toEqual(['gas_leak', 'gas_smell']);
    expect(merged.category).toBe('gas');
  });
});

describe('mergeClassification — stickiness', () => {
  it('stays emergency when a prior emergency is passed in with a benign model output', () => {
    const merged = mergeClassification(
      emergencyPrecheck('everything looks fine now'),
      model({ severity: 'cosmetic', emergencyFlag: false, category: 'other' }),
      true,
    );
    expect(merged.emergencyFlag).toBe(true);
    expect(merged.severity).toBe('emergency');
    expect(merged.deterministicEmergency).toBe(false);
    expect(merged.modelSeverity).toBe('cosmetic');
    expect(merged.rationale).toContain('priorEmergency=true');
  });

  it('defaults priorEmergency to false', () => {
    const merged = mergeClassification(emergencyPrecheck('the tap drips'), model());
    expect(merged.emergencyFlag).toBe(false);
    expect(merged.rationale).toContain('priorEmergency=false');
  });

  it('is monotone: an emergency flag never flips back to false', () => {
    const precheck = emergencyPrecheck('ريحة غاز');
    const first = mergeClassification(precheck, model({ severity: 'low' }));
    const second = mergeClassification(
      emergencyPrecheck('cleaned up'),
      model({ severity: 'cosmetic' }),
      first.emergencyFlag,
    );
    expect(first.emergencyFlag).toBe(true);
    expect(second.emergencyFlag).toBe(true);
    expect(second.severity).toBe('emergency');
  });
});
