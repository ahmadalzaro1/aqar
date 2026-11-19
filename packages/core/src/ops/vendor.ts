// Vendor scoring: a transparent, reproducible integer score in [0, 100].
//
// Formula (documented so a landlord can argue with it, not guess at it):
//   completionRate  = jobsCompleted / jobsTotal
//   onTimeRate      = jobsOnTime / jobsCompleted            (0 when nothing completed)
//   avgVarianceBps  = costVarianceBpsSum / jobsCompleted     (0 when nothing completed)
//   costScore       = max(0, 100 - floor(|avgVarianceBps| / 50))   (50 bps = 1 point)
//   reworkScore     = 100 - floor(jobsReworked / jobsTotal * 100)
//   score = round( completionRate*30 + onTimeRate*30 + costScore*0.2 + reworkScore*0.2 )
//
// All of it is computed in exact integer arithmetic (BigInt) with a single
// half-up rounding at the end, so the same numbers always give the same score —
// no float drift, no dependence on evaluation order.

import type { VendorScoreInput } from '@aqar/contracts';

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function clampBig(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Score a vendor from historical job outcomes; null when the vendor has no jobs
 * (an unproven vendor is not a bad vendor, and a made-up 0 would say otherwise).
 *
 * Child counts are clamped into [0, jobsTotal] (on-time into [0, jobsCompleted])
 * so malformed input cannot push the result outside [0, 100].
 */
export function vendorScore(input: VendorScoreInput): number | null {
  const { jobsTotal } = input;
  if (jobsTotal <= 0) return null;

  const total = BigInt(jobsTotal);
  const completedCount = Math.min(Math.max(input.jobsCompleted, 0), jobsTotal);
  const completed = BigInt(completedCount);
  const onTimeCount = Math.min(Math.max(input.jobsOnTime, 0), completedCount);
  const onTime = BigInt(onTimeCount);
  const reworked = BigInt(Math.min(Math.max(input.jobsReworked, 0), jobsTotal));
  const varianceSum = BigInt(input.costVarianceBpsSum);

  // costScore: floor(|avgVarianceBps| / 50) == floor(|sum| / (50 * completed)) for completed > 0.
  const costPenalty = completed === 0n ? 0n : absBig(varianceSum) / (50n * completed);
  const costScore = clampBig(100n - costPenalty, 0n, 100n);

  const reworkPenalty = (reworked * 100n) / total;
  const reworkScore = clampBig(100n - reworkPenalty, 0n, 100n);

  // Exact common denominator for the two fractional rates and the two integer
  // scores (each weighted 1/5).
  const denominator = completed === 0n ? 5n * total : 5n * total * completed;
  const completionTerm = 150n * completed * completed; // 30 * completed/total, scaled
  const onTimeTerm = completed === 0n ? 0n : 150n * onTime * total; // 30 * onTime/completed, scaled
  const costTerm = costScore * total * completed;
  const reworkTerm = reworkScore * total * completed;
  const numerator = completionTerm + onTimeTerm + costTerm + reworkTerm;

  // Half-up rounding of numerator/denominator: floor((2n + d) / (2d)).
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  return Number(clampBig(rounded, 0n, 100n));
}
