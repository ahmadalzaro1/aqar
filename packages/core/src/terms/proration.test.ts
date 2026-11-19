import { prorateRent } from './proration.js';

describe('prorateRent', () => {
  it('charges a full month when every day is covered', () => {
    expect(prorateRent(300_000, 30, 30)).toBe(300_000);
    expect(prorateRent(300_000, 31, 31)).toBe(300_000);
  });

  it('floors a partial month exactly once', () => {
    expect(prorateRent(300_000, 10, 30)).toBe(100_000);
    expect(prorateRent(100_000, 1, 3)).toBe(33_333);
    expect(prorateRent(1, 1, 3)).toBe(0);
  });

  it('handles a rent that does not divide evenly', () => {
    // 1000 * 7 / 31 = 225.8 -> 225
    expect(prorateRent(1_000, 7, 31)).toBe(225);
  });

  it('stays exact for large rents (no float multiplication)', () => {
    const expected = Number(BigInt(Number.MAX_SAFE_INTEGER) / 31n);
    expect(prorateRent(Number.MAX_SAFE_INTEGER, 1, 31)).toBe(expected);
  });

  it('rejects negative or non-integer money and impossible months', () => {
    expect(() => prorateRent(-1, 1, 30)).toThrow(RangeError);
    expect(() => prorateRent(1.5, 1, 30)).toThrow(RangeError);
    expect(() => prorateRent(100, -1, 30)).toThrow(RangeError);
    expect(() => prorateRent(100, 1, 0)).toThrow(RangeError);
    expect(() => prorateRent(100, 1, 32)).toThrow(RangeError);
  });
});
