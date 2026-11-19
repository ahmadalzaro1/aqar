import type { OwnerShare } from '@aqar/contracts';
import { allocateSharedService, splitByShares } from './shares.js';

function share(ownerId: string, shareBps: number): OwnerShare {
  return { ownerId, shareBps };
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

describe('splitByShares', () => {
  it('splits 1000 fils three ways without losing a fil', () => {
    // 10000 bps cannot be split into three equal integers, so 3334/3333/3333.
    const result = splitByShares(1000, [share('a', 3334), share('b', 3333), share('c', 3333)]);
    expect(result).toEqual({ a: 334, b: 333, c: 333 });
    expect(total([result.a ?? 0, result.b ?? 0, result.c ?? 0])).toBe(1000);
  });

  it('gives the odd fil to the largest remainder, ties by ownerId ascending', () => {
    expect(splitByShares(1001, [share('A', 5000), share('B', 5000)])).toEqual({ A: 501, B: 500 });
  });

  it('splits 1000001 fils across four equal heirs exactly', () => {
    const result = splitByShares(1_000_001, [
      share('heir-1', 2500),
      share('heir-2', 2500),
      share('heir-3', 2500),
      share('heir-4', 2500),
    ]);
    expect(result).toEqual({ 'heir-1': 250_001, 'heir-2': 250_000, 'heir-3': 250_000, 'heir-4': 250_000 });
    expect(total(Object.values(result))).toBe(1_000_001);
  });

  it('honours unequal shares', () => {
    const result = splitByShares(1_000_000, [share('owner-a', 6000), share('owner-b', 4000)]);
    expect(result).toEqual({ 'owner-a': 600_000, 'owner-b': 400_000 });
  });

  it('returns zero for every owner when the total is zero', () => {
    expect(splitByShares(0, [share('a', 5000), share('b', 5000)])).toEqual({ a: 0, b: 0 });
  });

  it('rejects shares that do not sum to exactly 10000 bps', () => {
    expect(() => splitByShares(1000, [share('a', 5000), share('b', 4999)])).toThrow(RangeError);
    expect(() => splitByShares(1000, [share('a', 5000), share('b', 5001)])).toThrow(RangeError);
  });

  it('rejects empty, duplicate or invalid shares', () => {
    expect(() => splitByShares(1000, [])).toThrow(RangeError);
    expect(() => splitByShares(1000, [share('a', 5000), share('a', 5000)])).toThrow(RangeError);
    expect(() => splitByShares(1000, [share('', 10000)])).toThrow(RangeError);
    expect(() => splitByShares(-1, [share('a', 10000)])).toThrow(RangeError);
  });
});

describe('allocateSharedService', () => {
  const units = [1, 1, 1];

  it('splits equally for per_unit and flat modes', () => {
    expect(allocateSharedService(1000, units, 'per_unit')).toEqual([334, 333, 333]);
    expect(allocateSharedService(1000, [50, 30, 20], 'flat')).toEqual([334, 333, 333]);
  });

  it('allocates generator amperes proportionally', () => {
    // 10 + 10 + 10 amperes on a 100 fils subscription.
    expect(allocateSharedService(100, [10, 10, 10], 'by_ampere')).toEqual([34, 33, 33]);
    expect(allocateSharedService(1000, [20, 30, 50], 'by_ampere')).toEqual([200, 300, 500]);
  });

  it('allocates by area and headcount proportionally', () => {
    expect(allocateSharedService(1000, [120, 80], 'by_area')).toEqual([600, 400]);
    expect(allocateSharedService(1000, [3, 1], 'by_headcount')).toEqual([750, 250]);
  });

  it('keeps every fil for awkward ratios', () => {
    const result = allocateSharedService(100, [1, 1, 1], 'by_area');
    expect(total(result)).toBe(100);
    expect(result).toEqual([34, 33, 33]);
  });

  it('rejects empty weights, all-zero proportional weights and negatives', () => {
    expect(() => allocateSharedService(100, [], 'per_unit')).toThrow(RangeError);
    expect(() => allocateSharedService(100, [0, 0, 0], 'by_area')).toThrow(RangeError);
    expect(() => allocateSharedService(100, [0, 0, 0], 'by_ampere')).toThrow(RangeError);
    expect(() => allocateSharedService(100, [-1, 2], 'by_area')).toThrow(RangeError);
  });

  it('allows all-zero weights for equal-split modes', () => {
    expect(allocateSharedService(100, [0, 0], 'per_unit')).toEqual([50, 50]);
  });
});
