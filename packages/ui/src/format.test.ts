import { describe, expect, it } from 'vitest';
import { cn, formatMoney, formatPercentBps } from './format.js';

describe('formatMoney', () => {
  it('renders 3 decimals with JOD prefix in English', () => {
    expect(formatMoney(1250500, 'en')).toBe('JOD 1,250.500');
  });
  it('renders Arabic suffix', () => {
    expect(formatMoney(1250500, 'ar')).toContain('د.أ');
  });
  it('renders zero', () => {
    expect(formatMoney(0, 'en')).toBe('JOD 0.000');
  });
});
describe('formatPercentBps', () => {
  it('converts basis points', () => {
    expect(formatPercentBps(5000, 'en')).toBe('50%');
  });
});
describe('cn', () => {
  it('joins truthy strings', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
});
