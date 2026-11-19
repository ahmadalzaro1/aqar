import { assertFils, formatFils, mulDivFloor, sumFils, toFils } from './index.js';

describe('assertFils', () => {
  it('accepts nonnegative safe integers and returns them', () => {
    expect(assertFils(0)).toBe(0);
    expect(assertFils(1250500)).toBe(1250500);
    expect(assertFils(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects fractions, negatives, NaN, infinities and unsafe integers', () => {
    expect(() => assertFils(1.5)).toThrow(/integer/);
    expect(() => assertFils(-1)).toThrow(/nonnegative/);
    expect(() => assertFils(Number.NaN)).toThrow(/integer/);
    expect(() => assertFils(Number.POSITIVE_INFINITY)).toThrow(/integer/);
    expect(() => assertFils(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe/);
  });
});

describe('toFils', () => {
  it('parses JOD decimals to integer fils', () => {
    expect(toFils('1250.500')).toBe(1250500);
    expect(toFils('1250.5')).toBe(1250500);
    expect(toFils('1250')).toBe(1250000);
    expect(toFils('1250.050')).toBe(1250050);
    expect(toFils('1250.005')).toBe(1250005);
    expect(toFils('0.001')).toBe(1);
    expect(toFils('0')).toBe(0);
    expect(toFils('007.250')).toBe(7250);
    expect(toFils('300.000')).toBe(300000);
  });

  it('rejects more than three decimals, signs, separators and garbage', () => {
    expect(() => toFils('1250.5001')).toThrow(/invalid JOD amount/);
    expect(() => toFils('-1.000')).toThrow(/invalid JOD amount/);
    expect(() => toFils('+1.000')).toThrow(/invalid JOD amount/);
    expect(() => toFils('1,000.000')).toThrow(/invalid JOD amount/);
    expect(() => toFils('abc')).toThrow(/invalid JOD amount/);
    expect(() => toFils('')).toThrow(/invalid JOD amount/);
    expect(() => toFils('.5')).toThrow(/invalid JOD amount/);
    expect(() => toFils('1.')).toThrow(/invalid JOD amount/);
    expect(() => toFils(' 1.000 ')).toThrow(/invalid JOD amount/);
    expect(() => toFils('1e3')).toThrow(/invalid JOD amount/);
    expect(() => toFils('9007199254740991.999')).toThrow(/safe/);
  });

  it('never round-trips through floating point', () => {
    // 0.1 + 0.2 style artefacts would show up as 100 vs 99 here.
    expect(toFils('0.100') + toFils('0.200')).toBe(300);
    expect(toFils('19.999')).toBe(19999);
  });
});

describe('formatFils', () => {
  it('formats with exactly three decimals and no separators', () => {
    expect(formatFils(1250500)).toBe('1250.500');
    expect(formatFils(0)).toBe('0.000');
    expect(formatFils(1)).toBe('0.001');
    expect(formatFils(10)).toBe('0.010');
    expect(formatFils(100)).toBe('0.100');
    expect(formatFils(123456789)).toBe('123456.789');
    expect(formatFils(1000000000)).toBe('1000000.000');
  });

  it('rejects non-fils input', () => {
    expect(() => formatFils(1.5)).toThrow(/integer/);
    expect(() => formatFils(-1)).toThrow(/nonnegative/);
  });
});

describe('mulDivFloor / sumFils', () => {
  it('floors exact rational money math', () => {
    expect(mulDivFloor(300000, 16, 31)).toBe(154838);
    expect(mulDivFloor(1001, 333, 10000)).toBe(33);
    expect(mulDivFloor(200000, 500, 10000)).toBe(10000);
    expect(mulDivFloor(Number.MAX_SAFE_INTEGER, 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects invalid arguments', () => {
    expect(() => mulDivFloor(1.5, 2, 3)).toThrow(/safe integers/);
    expect(() => mulDivFloor(1, 2, 0)).toThrow(/positive divisor/);
  });

  it('sums fils and refuses overflow', () => {
    expect(sumFils([100, 200, 300])).toBe(600);
    expect(sumFils([])).toBe(0);
    expect(() => sumFils([-1])).toThrow(/nonnegative/);
    expect(() => sumFils([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toThrow(/safe/);
  });
});
