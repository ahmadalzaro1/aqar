import type { OwnerShare, SharedAllocationMode } from '@aqar/contracts';
import { apportionLargestRemainder, assertNonNegativeInteger } from './internal.js';

const FULL_SHARE_BPS = 10000;

/**
 * Splits `totalFils` across owners by basis points using largest remainder.
 *
 * Shares must be nonempty, have unique ownerIds, and sum to EXACTLY 10000 bps.
 * Every fil is assigned: the output values always sum to `totalFils`, never
 * losing the remainder fils that plain flooring would drop.
 */
export function splitByShares(
  totalFils: number,
  shares: readonly OwnerShare[],
): Record<string, number> {
  const total = assertNonNegativeInteger(totalFils, 'totalFils');
  if (shares.length === 0) {
    throw new RangeError('shares must not be empty');
  }
  const seen = new Set<string>();
  const weights: number[] = [];
  const keys: string[] = [];
  let bpsSum = 0;
  for (const share of shares) {
    if (share.ownerId.length === 0) {
      throw new RangeError('share ownerId must not be empty');
    }
    if (seen.has(share.ownerId)) {
      throw new RangeError(`duplicate ownerId in shares: ${share.ownerId}`);
    }
    seen.add(share.ownerId);
    const bps = assertNonNegativeInteger(share.shareBps, 'shareBps');
    if (bps > FULL_SHARE_BPS) {
      throw new RangeError(`shareBps must be <= ${String(FULL_SHARE_BPS)}`);
    }
    weights.push(bps);
    keys.push(share.ownerId);
    bpsSum += bps;
  }
  if (bpsSum !== FULL_SHARE_BPS) {
    throw new RangeError(
      `shareBps must sum to exactly ${String(FULL_SHARE_BPS)} (received ${String(bpsSum)})`,
    );
  }

  const amounts = apportionLargestRemainder(total, weights, keys);
  const result: Record<string, number> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const ownerId = keys[index] ?? '';
    result[ownerId] = amounts[index] ?? 0;
  }
  return result;
}

const PROPORTIONAL_MODES: ReadonlySet<SharedAllocationMode> = new Set<SharedAllocationMode>([
  'by_area',
  'by_headcount',
  'by_ampere',
]);

/**
 * Jordanian shared-building billing: distribute a shared service invoice
 * (generator amperes subscription, water tank delivery, elevator maintenance,
 * common-area electricity, cleaning) across units.
 *
 * `per_unit` and `flat` split equally; `by_area`, `by_headcount` and
 * `by_ampere` split proportionally to the integer weights. Largest remainder
 * guarantees the returned array always sums exactly to `totalFils`.
 */
export function allocateSharedService(
  totalFils: number,
  weights: readonly number[],
  mode: SharedAllocationMode,
): number[] {
  const total = assertNonNegativeInteger(totalFils, 'totalFils');
  if (weights.length === 0) {
    throw new RangeError('weights must not be empty');
  }
  for (const weight of weights) {
    assertNonNegativeInteger(weight, 'weight');
  }
  const proportional = PROPORTIONAL_MODES.has(mode);
  if (!proportional && mode !== 'per_unit' && mode !== 'flat') {
    throw new RangeError(`unsupported shared allocation mode: ${String(mode)}`);
  }
  const effectiveWeights = proportional ? [...weights] : weights.map(() => 1);
  const tieKeys = weights.map((_weight, index) => String(index).padStart(8, '0'));
  return apportionLargestRemainder(total, effectiveWeights, tieKeys);
}
