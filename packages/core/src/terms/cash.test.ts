import { depositRefund, distributionWaterfall, managementFee } from './cash.js';

describe('depositRefund', () => {
  it('subtracts the sum of deductions', () => {
    expect(depositRefund(500_000, [100_000, 50_000])).toBe(350_000);
    expect(depositRefund(500_000, [])).toBe(500_000);
    expect(depositRefund(500_000, [500_000])).toBe(0);
  });

  it('throws when deductions exceed the deposit', () => {
    expect(() => depositRefund(100_000, [60_000, 60_000])).toThrow(RangeError);
  });

  it('throws on a negative deduction', () => {
    expect(() => depositRefund(100_000, [-1])).toThrow(RangeError);
  });

  it('throws on negative or fractional deposits', () => {
    expect(() => depositRefund(-1, [])).toThrow(RangeError);
    expect(() => depositRefund(1.5, [])).toThrow(RangeError);
  });
});

describe('managementFee', () => {
  it('is floor(collected * bps / 10000)', () => {
    expect(managementFee(200_000, 500)).toBe(10_000);
    expect(managementFee(200_000, 0)).toBe(0);
    expect(managementFee(199_999, 500)).toBe(9_999);
    expect(managementFee(200_000, 10_000)).toBe(200_000);
  });

  it('rejects impossible basis points', () => {
    expect(() => managementFee(1000, 10_001)).toThrow(RangeError);
    expect(() => managementFee(1000, -1)).toThrow(RangeError);
  });
});

describe('distributionWaterfall', () => {
  it('subtracts fee, expenses and reserve from gross collections', () => {
    expect(distributionWaterfall(1_000_000, 50_000, 100_000, 200_000)).toBe(650_000);
    expect(distributionWaterfall(1_000_000, 0, 0, 0)).toBe(1_000_000);
  });

  it('allows a zero net payable', () => {
    expect(distributionWaterfall(300_000, 50_000, 100_000, 150_000)).toBe(0);
  });

  it('throws instead of paying a negative amount', () => {
    expect(() => distributionWaterfall(100_000, 50_000, 100_000, 0)).toThrow(RangeError);
  });

  it('rejects negative inputs', () => {
    expect(() => distributionWaterfall(-1, 0, 0, 0)).toThrow(RangeError);
    expect(() => distributionWaterfall(100, -1, 0, 0)).toThrow(RangeError);
  });
});
