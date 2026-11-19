import { describe, expect, it } from 'vitest';
import type { Severity } from '@aqar/contracts';
import { defaultServiceStandard, slaDueDates, slaState } from './sla.js';

const OPENED = '2026-03-01T08:00:00.000Z';

describe('defaultServiceStandard', () => {
  const standard = defaultServiceStandard();

  it('is identified as a configurable Jordan default, not law', () => {
    expect(standard.id).toBe('jordan-default');
    expect(standard.propertyClass).toBe('residential');
    expect(standard.name.length).toBeGreaterThan(0);
    expect(standard.name).toMatch(/[A-Za-z]/);
    expect(standard.name).toMatch(/[\u0600-\u06FF]/);
  });

  it('uses the agreed conservative clocks', () => {
    expect(standard.clocks).toEqual({
      emergency: { responseMinutes: 0, resolutionMinutes: 240 },
      high: { responseMinutes: 240, resolutionMinutes: 1440 },
      medium: { responseMinutes: 1440, resolutionMinutes: 4320 },
      low: { responseMinutes: 2880, resolutionMinutes: 10080 },
      cosmetic: { responseMinutes: 4320, resolutionMinutes: 20160 },
    });
  });

  it('tightens monotonically from cosmetic to emergency', () => {
    const order: readonly Severity[] = ['emergency', 'high', 'medium', 'low', 'cosmetic'];
    for (let i = 1; i < order.length; i += 1) {
      const prev = standard.clocks[order[i - 1] as Severity];
      const cur = standard.clocks[order[i] as Severity];
      expect(prev.responseMinutes).toBeLessThanOrEqual(cur.responseMinutes);
      expect(prev.resolutionMinutes).toBeLessThanOrEqual(cur.resolutionMinutes);
    }
  });

  it('returns a fresh copy each call (callers may not mutate shared state)', () => {
    const a = defaultServiceStandard();
    a.clocks.emergency.responseMinutes = 999;
    expect(defaultServiceStandard().clocks.emergency.responseMinutes).toBe(0);
  });
});

describe('slaDueDates', () => {
  const standard = defaultServiceStandard();

  it('makes an emergency respond-by deadline equal to the opening instant', () => {
    const due = slaDueDates(standard, 'emergency', OPENED);
    expect(due.responseDueISO).toBe('2026-03-01T08:00:00.000Z');
    expect(due.resolutionDueISO).toBe('2026-03-01T12:00:00.000Z');
  });

  it('adds clock minutes arithmetically for high severity', () => {
    const due = slaDueDates(standard, 'high', OPENED);
    expect(due.responseDueISO).toBe('2026-03-01T12:00:00.000Z');
    expect(due.resolutionDueISO).toBe('2026-03-02T08:00:00.000Z');
  });

  it('crosses month boundaries by instant arithmetic', () => {
    const due = slaDueDates(standard, 'low', '2026-01-30T10:00:00.000Z');
    // low: response 2880 min = 48 h, resolution 10080 min = 7 days
    expect(due.responseDueISO).toBe('2026-02-01T10:00:00.000Z');
    expect(due.resolutionDueISO).toBe('2026-02-06T10:00:00.000Z');
  });

  it('honours a custom pack instead of the default', () => {
    const custom = {
      id: 'custom',
      name: 'Custom',
      propertyClass: 'commercial',
      clocks: {
        ...defaultServiceStandard().clocks,
        medium: { responseMinutes: 60, resolutionMinutes: 120 },
      },
    };
    const due = slaDueDates(custom, 'medium', OPENED);
    expect(due.responseDueISO).toBe('2026-03-01T09:00:00.000Z');
    expect(due.resolutionDueISO).toBe('2026-03-01T10:00:00.000Z');
  });
});

describe('slaState', () => {
  const standard = defaultServiceStandard();

  it('is not breached before the deadline and breaches strictly after it', () => {
    const before = slaState(standard, 'high', OPENED, null, null, '2026-03-01T11:59:00.000Z');
    expect(before.responseBreached).toBe(false);
    expect(before.resolutionBreached).toBe(false);

    const exactly = slaState(standard, 'high', OPENED, null, null, '2026-03-01T12:00:00.000Z');
    expect(exactly.responseBreached).toBe(false);

    const after = slaState(standard, 'high', OPENED, null, null, '2026-03-01T12:01:00.000Z');
    expect(after.responseBreached).toBe(true);
    expect(after.resolutionBreached).toBe(false);
  });

  it('reports the due timestamps it measured against', () => {
    const state = slaState(standard, 'medium', OPENED, null, null, OPENED);
    expect(state.responseDueISO).toBe('2026-03-02T08:00:00.000Z');
    expect(state.resolutionDueISO).toBe('2026-03-04T08:00:00.000Z');
  });

  it('uses the recorded response instant, not now, once a response exists', () => {
    const onTime = slaState(standard, 'high', OPENED, '2026-03-01T10:00:00.000Z', null, '2026-04-01T00:00:00.000Z');
    expect(onTime.responseBreached).toBe(false);
    expect(onTime.resolutionBreached).toBe(true);

    const late = slaState(standard, 'high', OPENED, '2026-03-01T13:00:00.000Z', null, '2026-03-01T13:05:00.000Z');
    expect(late.responseBreached).toBe(true);
  });

  it('stops the resolution clock when the ticket is resolved', () => {
    const resolvedOnTime = slaState(standard, 'high', OPENED, '2026-03-01T10:00:00.000Z', '2026-03-02T07:00:00.000Z', '2026-05-01T00:00:00.000Z');
    expect(resolvedOnTime.responseBreached).toBe(false);
    expect(resolvedOnTime.resolutionBreached).toBe(false);

    const resolvedLate = slaState(standard, 'high', OPENED, '2026-03-01T10:00:00.000Z', '2026-03-02T07:01:00.000Z', '2026-03-02T07:02:00.000Z');
    expect(resolvedLate.resolutionBreached).toBe(true);
  });

  it('treats an emergency as breached one minute after opening', () => {
    expect(slaState(standard, 'emergency', OPENED, null, null, OPENED).responseBreached).toBe(false);
    expect(slaState(standard, 'emergency', OPENED, null, null, '2026-03-01T08:01:00.000Z').responseBreached).toBe(true);
  });

  it('rejects malformed instants rather than silently scoring them', () => {
    expect(() => slaState(standard, 'high', 'not-a-date', null, null, OPENED)).toThrow(/invalid ISO instant/);
    expect(() => slaState(standard, 'high', OPENED, null, null, 'nope')).toThrow(/invalid ISO instant/);
  });
});
