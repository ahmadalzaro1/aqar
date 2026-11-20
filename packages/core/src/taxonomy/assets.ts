/**
 * The asset is not the space.
 *
 * A `properties` row is a registered thing — a parcel with a deed, a tower, a
 * farm — and it may contain many lettable spaces or none. Conflating the two is
 * what forced the v1 model to pretend every space was a flat in a building: a
 * plot of land had no way to exist because it had no building to belong to.
 *
 * `asset_kind` answers "what did we buy / what do we administer"; `space_kind`
 * answers "what can be leased".
 */

export const ASSET_KINDS = [
  'parcel',
  'building',
  'compound',
  'tower',
  'farm',
  'mixed_use',
  'infrastructure',
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/** Zoning is what the municipality says may happen there; it is not a promise. */
export const ZONING = [
  'residential',
  'commercial',
  'industrial',
  'agricultural',
  'mixed',
  'touristic',
  'educational',
  'health',
  'religious',
  'public',
  'military',
] as const;

export type Zoning = (typeof ZONING)[number];

/** An asset that can hold lettable spaces under it. */
export function isContainable(kind: AssetKind): boolean {
  return kind !== 'parcel' && kind !== 'infrastructure';
}

/**
 * The spaces an asset kind can legitimately contain, used to refuse a shop inside
 * a farm's parcel in the console before the database has to.
 */
export function allowedSpaceKinds(asset: AssetKind, zoning: Zoning | null): readonly string[] {
  switch (asset) {
    case 'parcel':
      return zoning === 'agricultural' ? ['land', 'farm'] : ['land', 'parking', 'signage'];
    case 'farm':
      return ['farm', 'land', 'warehouse', 'staff_housing'];
    case 'tower':
    case 'building':
      return ['flat', 'villa', 'office', 'shop', 'showroom', 'workshop', 'warehouse', 'parking', 'rooftop', 'staff_housing', 'signage'];
    case 'compound':
      return ['villa', 'flat', 'staff_housing', 'labour_camp', 'parking', 'rooftop'];
    case 'mixed_use':
      return ['flat', 'office', 'shop', 'showroom', 'parking', 'rooftop', 'warehouse'];
    case 'infrastructure':
      return ['signage', 'rooftop'];
  }
}
