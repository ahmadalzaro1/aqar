import { describe, expect, it } from 'vitest';
import { vendorScore } from './vendor.js';

describe('vendorScore — deterministic performance score', () => {
  it('perfect vendor scores 100', () => {
    expect(vendorScore({ jobsTotal: 10, jobsCompleted: 10, jobsOnTime: 10, costVarianceBpsSum: 0, jobsReworked: 0 })).toBe(100);
  });

  it('no jobs returns null (unrated), never a fake 0', () => {
    expect(vendorScore({ jobsTotal: 0, jobsCompleted: 0, jobsOnTime: 0, costVarianceBpsSum: 0, jobsReworked: 0 })).toBeNull();
  });

  it('zero completions scores 0: nothing delivered, nothing demonstrated', () => {
    expect(vendorScore({ jobsTotal: 4, jobsCompleted: 0, jobsOnTime: 0, costVarianceBpsSum: 0, jobsReworked: 0 })).toBe(0);
  });

  it('hand-computed mixed case: 3 jobs, 2 on time, 1 reworked -> 83', () => {
    // completion 30 + onTime 20 + cost 20 + rework (100-33)*0.2=13.4 => 83.4 -> 83
    expect(vendorScore({ jobsTotal: 3, jobsCompleted: 3, jobsOnTime: 2, costVarianceBpsSum: 0, jobsReworked: 1 })).toBe(83);
  });

  it('cost variance and rework both penalize: 94', () => {
    // avg variance 500bps -> cost 90 -> 18; rework 2/10 -> 80 -> 16; 30+30+18+16=94
    expect(vendorScore({ jobsTotal: 10, jobsCompleted: 10, jobsOnTime: 10, costVarianceBpsSum: 5000, jobsReworked: 2 })).toBe(94);
  });

  it('overrun and underrun are penalized symmetrically (absolute variance)', () => {
    const over = vendorScore({ jobsTotal: 5, jobsCompleted: 5, jobsOnTime: 5, costVarianceBpsSum: 2500, jobsReworked: 0 });
    const under = vendorScore({ jobsTotal: 5, jobsCompleted: 5, jobsOnTime: 5, costVarianceBpsSum: -2500, jobsReworked: 0 });
    expect(over).toBe(under);
  });

  it('malformed children clamp instead of exploding', () => {
    const score = vendorScore({ jobsTotal: 5, jobsCompleted: 99, jobsOnTime: 99, costVarianceBpsSum: 0, jobsReworked: -3 });
    expect(score).toBe(100);
  });

  it('all reworked vendors lose the full rework term', () => {
    expect(vendorScore({ jobsTotal: 10, jobsCompleted: 10, jobsOnTime: 10, costVarianceBpsSum: 0, jobsReworked: 10 })).toBe(80);
  });
});
