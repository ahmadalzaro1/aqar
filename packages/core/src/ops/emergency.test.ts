import { describe, expect, it } from 'vitest';
import { emergencyPrecheck, HAZARD_SIGNALS, hazardSignalCategory } from './emergency.js';

describe('emergencyPrecheck — hazard catalogue coverage', () => {
  const cases: ReadonlyArray<{ text: string; signal: string }> = [
    // gas
    { text: 'ريحة غاز قوية بالمطبخ', signal: 'gas_smell' },
    { text: 'رائحة غاز', signal: 'gas_smell' },
    { text: 'في ريحة غاز بالصالة', signal: 'gas_smell' },
    { text: 'gas smell in the kitchen', signal: 'gas_smell' },
    { text: 'there is a smell of gas near the stove', signal: 'gas_smell' },
    { text: 'تسرب غاز من الاسطوانة', signal: 'gas_leak' },
    { text: 'gas leak in the corridor', signal: 'gas_leak' },
    // fire / smoke
    { text: 'في حريق بالمطبخ', signal: 'fire' },
    { text: 'fire in the kitchen', signal: 'fire' },
    { text: 'في نار بالغرفة', signal: 'fire' },
    { text: 'في دخان كثير', signal: 'smoke' },
    { text: 'smoke coming from the socket', signal: 'smoke' },
    // sewage
    { text: 'المجاري طافحة بالحمام', signal: 'sewage' },
    { text: 'صرف صحي طالع بالحوش', signal: 'sewage' },
    { text: 'sewage backup in the basement', signal: 'sewage' },
    // water
    { text: 'ما في مي من الصبح', signal: 'no_water' },
    { text: 'مافي مي', signal: 'no_water' },
    { text: 'ما في مياه بالشقة', signal: 'no_water' },
    { text: 'انقطاع المياه عن الوحدة', signal: 'no_water' },
    { text: 'no water since yesterday', signal: 'no_water' },
    { text: 'water cut off this morning', signal: 'no_water' },
    // electrical
    { text: 'شرر من المقبس', signal: 'electrical_hazard' },
    { text: 'الأسلاك مكشوفة بالحمام', signal: 'electrical_hazard' },
    { text: 'في التماس كهربائي', signal: 'electrical_hazard' },
    { text: 'spark from the outlet', signal: 'electrical_hazard' },
    { text: 'exposed wire in the bathroom', signal: 'electrical_hazard' },
    // structural
    { text: 'في تصدع بالجدار', signal: 'structural' },
    { text: 'التصدع زاد بالسقف', signal: 'structural' },
    { text: 'wall collapse in the bedroom', signal: 'structural' },
    { text: 'crack in the ceiling', signal: 'structural' },
    // lock
    { text: 'قفل الباب خربان', signal: 'lock_failure' },
    { text: 'مقفل وما بقدر افتح', signal: 'lock_failure' },
    { text: 'locked out of the apartment', signal: 'lock_failure' },
    { text: 'lock broken on the main door', signal: 'lock_failure' },
    // heat
    { text: 'ما في تدفئة', signal: 'no_heat' },
    { text: 'no heat in the flat', signal: 'no_heat' },
    // elevator
    { text: 'محتجز بالمصعد', signal: 'elevator_entrapment' },
    { text: 'trapped in elevator', signal: 'elevator_entrapment' },
    { text: 'عالق في المصعد', signal: 'elevator_entrapment' },
    // flooding
    { text: 'فيضان بالمطبخ', signal: 'flooding' },
    { text: 'تسرب مياه من الحمام', signal: 'flooding' },
    { text: 'burst pipe under the sink', signal: 'flooding' },
  ];

  for (const { text, signal } of cases) {
    it(`detects ${signal} in: ${text}`, () => {
      const result = emergencyPrecheck(text);
      expect(result.emergency).toBe(true);
      expect(result.signals).toContain(signal);
    });
  }

  it('covers every catalogued signal with at least one matching sample', () => {
    const matched = new Set<string>();
    for (const { text } of cases) {
      for (const signal of emergencyPrecheck(text).signals) matched.add(signal);
    }
    for (const signal of HAZARD_SIGNALS) {
      expect(matched, `no sample text exercised signal '${signal.id}'`).toContain(signal.id);
    }
  });
});

describe('emergencyPrecheck — output shape', () => {
  it('sets safetyInstructionsKey to the first matched signal and emergency true', () => {
    const result = emergencyPrecheck('ريحة غاز قوية بالمطبخ');
    expect(result).toEqual({
      emergency: true,
      signals: ['gas_smell'],
      safetyInstructionsKey: 'gas_smell',
    });
  });

  it('prefers the more specific signal when several match', () => {
    const result = emergencyPrecheck('تسرب غاز في المطبخ');
    expect(result.signals).toEqual(['gas_leak', 'gas_smell']);
    expect(result.safetyInstructionsKey).toBe('gas_leak');
  });

  it('deduplicates signals that match through several patterns', () => {
    const result = emergencyPrecheck('gas smell and a strong gas smell, maybe a gas leak');
    expect(result.signals).toEqual(['gas_leak', 'gas_smell']);
  });

  it('returns a non-emergency result with null key for benign text', () => {
    const result = emergencyPrecheck('بدي أعرف موعد دفع الإيجار');
    expect(result).toEqual({ emergency: false, signals: [], safetyInstructionsKey: null });
  });

  it('handles empty input without throwing', () => {
    expect(emergencyPrecheck('')).toEqual({
      emergency: false,
      signals: [],
      safetyInstructionsKey: null,
    });
  });

  it('is deterministic: same text twice gives equal results', () => {
    const a = emergencyPrecheck('في حريق ودخان بالمطبخ');
    const b = emergencyPrecheck('في حريق ودخان بالمطبخ');
    expect(a).toEqual(b);
  });
});

describe('emergencyPrecheck — safety bias', () => {
  it('does NOT clear a flag on negation (false positives are cheap, misses are not)', () => {
    expect(emergencyPrecheck('ما في ريحة غاز').emergency).toBe(true);
    expect(emergencyPrecheck('no gas smell here').emergency).toBe(true);
    expect(emergencyPrecheck('there is no fire').emergency).toBe(true);
    expect(emergencyPrecheck('ما في تسرب غاز أبداً').emergency).toBe(true);
  });

  it('flags a bare mention of gas as a hazard (escalate first, de-escalate with a human)', () => {
    expect(emergencyPrecheck('بدي أفحص الغاز').signals).toContain('gas_smell');
  });
});

describe('emergencyPrecheck — phrase boundaries', () => {
  it('does not fire on look-alike words', () => {
    expect(emergencyPrecheck('منارة الشارع مكسورة').signals).toEqual([]);
    expect(emergencyPrecheck('the gasket on the sink is worn').signals).toEqual([]);
    expect(emergencyPrecheck('I need a plumber for the toilet').signals).toEqual([]);
    expect(emergencyPrecheck('المكيف ما ببرد').signals).toEqual([]);
  });

  it('matches patterns preceded by the Arabic definite article', () => {
    expect(emergencyPrecheck('التصدع زاد').signals).toContain('structural');
    expect(emergencyPrecheck('الغاز طالع').signals).toContain('gas_smell');
    expect(emergencyPrecheck('الأسلاك مكشوفة').signals).toContain('electrical_hazard');
  });

  it('matches mixed Arabic/English text', () => {
    const result = emergencyPrecheck('في gas smell بالمطبخ');
    expect(result.emergency).toBe(true);
    expect(result.signals).toContain('gas_smell');
  });
});

describe('hazardSignalCategory', () => {
  it('maps hazard signals to ticket categories', () => {
    expect(hazardSignalCategory('gas_smell')).toBe('gas');
    expect(hazardSignalCategory('fire')).toBe('fire');
    expect(hazardSignalCategory('smoke')).toBe('fire');
    expect(hazardSignalCategory('electrical_hazard')).toBe('electrical');
    expect(hazardSignalCategory('sewage')).toBe('sewage');
    expect(hazardSignalCategory('no_water')).toBe('water');
    expect(hazardSignalCategory('flooding')).toBe('water');
    expect(hazardSignalCategory('structural')).toBe('structural');
    expect(hazardSignalCategory('lock_failure')).toBe('lock');
    expect(hazardSignalCategory('elevator_entrapment')).toBe('elevator');
    expect(hazardSignalCategory('no_heat')).toBe('hvac');
  });

  it('returns undefined for unknown signal ids', () => {
    expect(hazardSignalCategory('volcano')).toBeUndefined();
  });
});
