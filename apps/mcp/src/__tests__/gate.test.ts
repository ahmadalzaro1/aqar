import { describe, expect, it } from 'vitest';
import { localHourIn } from '../gate.js';

/**
 * Quiet hours are a local-time concept. Getting this wrong means an agent pings
 * tenants at 03:00 because it compared a UTC hour to a local window.
 */
describe('localHourIn', () => {
  it('reads the local hour in Amman, not UTC (UTC+3, no DST since 2022)', () => {
    expect(localHourIn('Asia/Amman', new Date('2026-11-20T19:00:00Z'))).toBe(22);
    expect(localHourIn('Asia/Amman', new Date('2026-11-20T19:00:00Z'))).not.toBe(19);
  });

  it('wraps across midnight in the local zone', () => {
    // 2026-11-20T22:30Z is 01:30 on the 21st in Amman — inside the 22–07 window.
    expect(localHourIn('Asia/Amman', new Date('2026-11-20T22:30:00Z'))).toBe(1);
  });

  it('handles a negative-offset zone', () => {
    expect(localHourIn('America/New_York', new Date('2026-11-20T19:00:00Z'))).toBe(14);
  });

  it('uses h23 so midnight is 0, never 24', () => {
    expect(localHourIn('UTC', new Date('2026-11-20T00:00:00Z'))).toBe(0);
  });

  it('propagates Intl RangeError for a bogus zone; guarded() turns it into a tool error', () => {
    expect(() => localHourIn('Mars/Olympus', new Date('2026-11-20T00:00:00Z'))).toThrow(RangeError);
  });
});
