import { noticeDeadline, renewalOfferWindow } from './dates.js';

describe('noticeDeadline', () => {
  it('subtracts calendar days from the lease end', () => {
    expect(noticeDeadline('2026-03-31', 60)).toBe('2026-01-30');
    expect(noticeDeadline('2026-06-30', 30)).toBe('2026-05-31');
  });

  it('returns the lease end itself for zero notice days', () => {
    expect(noticeDeadline('2026-12-31', 0)).toBe('2026-12-31');
  });

  it('crosses leap days correctly', () => {
    expect(noticeDeadline('2028-03-01', 1)).toBe('2028-02-29');
    expect(noticeDeadline('2027-03-01', 1)).toBe('2027-02-28');
  });

  it('crosses year boundaries', () => {
    expect(noticeDeadline('2027-01-15', 20)).toBe('2026-12-26');
  });

  it('rejects impossible dates and negative notice days', () => {
    expect(() => noticeDeadline('2026-02-30', 10)).toThrow(RangeError);
    expect(() => noticeDeadline('2026-2-3', 10)).toThrow(RangeError);
    expect(() => noticeDeadline('2026-03-31', -5)).toThrow(RangeError);
  });
});

describe('renewalOfferWindow', () => {
  it('ends on the lease end date', () => {
    expect(renewalOfferWindow('2026-06-30', 90)).toEqual({
      startISO: '2026-04-01',
      endISO: '2026-06-30',
    });
  });

  it('collapses to a single day when the window is zero days', () => {
    expect(renewalOfferWindow('2026-06-30', 0)).toEqual({
      startISO: '2026-06-30',
      endISO: '2026-06-30',
    });
  });

  it('rejects negative windows', () => {
    expect(() => renewalOfferWindow('2026-06-30', -1)).toThrow(RangeError);
  });
});
