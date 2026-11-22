/**
 * What a lettable space is, and which attributes its kind actually has.
 *
 * The v1 model assumed every space was a flat: `units` required a building and
 * required bedrooms. Land has neither, a warehouse has no bedrooms but needs a
 * clear height, and a shop's negotiable detail is frontage. The vocabulary below
 * is the same list the database enum uses — the `space_kind` type in migration
 * 0008 — so a value that exists in one exists in the other, and the test suite
 * asserts it value by value.
 *
 * `detail` names the 1:1 table that carries kind-specific attributes. Four kinds
 * share one table because they share every attribute (a staff room is a flat with
 * a different lease); the database enforces the pairing with a trigger, not trust.
 */

export const SPACE_KINDS = [
  'flat',
  'villa',
  'staff_housing',
  'labour_camp',
  'office',
  'shop',
  'showroom',
  'workshop',
  'warehouse',
  'cold_store',
  'land',
  'farm',
  'rooftop',
  'parking',
  'signage',
] as const;

export type SpaceKind = (typeof SPACE_KINDS)[number];

export type DetailFamily =
  | 'residential'
  | 'commercial'
  | 'industrial'
  | 'land'
  | 'farm'
  | 'rooftop'
  | 'parking'
  | 'signage';

const RESIDENTIAL: readonly SpaceKind[] = ['flat', 'villa', 'staff_housing', 'labour_camp'];
const COMMERCIAL: readonly SpaceKind[] = ['office', 'shop', 'showroom', 'workshop'];
const INDUSTRIAL: readonly SpaceKind[] = ['warehouse', 'cold_store'];

export const SPACE_DETAIL: Readonly<Record<SpaceKind, DetailFamily>> = {
  flat: 'residential',
  villa: 'residential',
  staff_housing: 'residential',
  labour_camp: 'residential',
  office: 'commercial',
  shop: 'commercial',
  showroom: 'commercial',
  workshop: 'commercial',
  warehouse: 'industrial',
  cold_store: 'industrial',
  land: 'land',
  farm: 'farm',
  rooftop: 'rooftop',
  // A bay and a billboard used to share the land table, which is why a bay could
  // only ever record a plot number and a FAR — attributes it does not have.
  parking: 'parking',
  signage: 'signage',
};

export const DETAIL_TABLE: Readonly<Record<DetailFamily, string>> = {
  residential: 'unit_residential_detail',
  commercial: 'unit_commercial_detail',
  industrial: 'unit_industrial_detail',
  land: 'unit_land_detail',
  farm: 'unit_farm_detail',
  rooftop: 'unit_rooftop_detail',
  parking: 'unit_parking_detail',
  signage: 'unit_signage_detail',
};

export function isResidential(kind: SpaceKind): boolean {
  return RESIDENTIAL.includes(kind);
}

export function isCommercial(kind: SpaceKind): boolean {
  return COMMERCIAL.includes(kind);
}

export function isIndustrial(kind: SpaceKind): boolean {
  return INDUSTRIAL.includes(kind);
}

/**
 * True when the space must hang off a building row.
 *
 * A rooftop is the roof of a building, so it needs one — without the link, two
 * roofs on the same property are indistinguishable and there is no honest value
 * for a roof that belongs to nothing. Land and farm must NOT have one. Parking
 * and signage may go either way: an underground bay or a facade sign hangs off a
 * building, a surface bay or a roadside billboard does not.
 */
export function needsBuilding(kind: SpaceKind): boolean {
  return kind !== 'land' && kind !== 'farm' && kind !== 'parking' && kind !== 'signage';
}

/** True when the kind may sit on a parcel with no building, but may also have one. */
export function buildingOptional(kind: SpaceKind): boolean {
  return kind === 'parking' || kind === 'signage';
}

/**
 * Attributes a space must carry before it can be advertised or leased.
 *
 * This is a publish gate, not a database rule: a half-described warehouse can
 * exist while it is being surveyed. It cannot be listed, because a commercial
 * tenant chooses on clear height and frontage, and a listing that omits them
 * wastes both sides' time.
 */
export const PUBLISH_ATTRIBUTES: Readonly<Record<SpaceKind, readonly string[]>> = {
  flat: ['area_sqm'],
  villa: ['area_sqm', 'has_parking'],
  staff_housing: ['area_sqm'],
  labour_camp: ['area_sqm'],
  office: ['area_sqm', 'fit_out'],
  shop: ['area_sqm', 'frontage_m'],
  showroom: ['area_sqm', 'frontage_m'],
  workshop: ['area_sqm'],
  warehouse: ['area_sqm', 'clear_height_m', 'dock_doors'],
  cold_store: ['area_sqm', 'clear_height_m', 'temperature_c'],
  land: ['plot_area_sqm'],
  farm: ['area_dunums'],
  rooftop: ['load_capacity_kg_sqm'],
  // "How much is it" is not a bay's question; "does my car fit" is.
  parking: ['bay_width_m', 'bay_length_m', 'clearance_m'],
  signage: ['face_area_sqm', 'orientation'],
};

/** The attributes the model must never invent, and the console must always ask for. */
export function missingPublishAttributes(
  kind: SpaceKind,
  detail: Readonly<Record<string, unknown>>,
): readonly string[] {
  return PUBLISH_ATTRIBUTES[kind].filter((key) => {
    const value = detail[key];
    return value === undefined || value === null || value === '';
  });
}

/**
 * A lease kind is a claim about what the space is; a mismatch is a data-entry
 * error that produces the wrong billing cycle downstream.
 */
export function spaceAllowsLeaseKind(
  kind: SpaceKind,
  lease:
    | 'residential'
    | 'commercial'
    | 'industrial'
    | 'agricultural'
    | 'short_term'
    | 'parking'
    | 'bare_land',
): boolean {
  if (kind === 'parking') return lease === 'parking' || lease === 'short_term';
  if (kind === 'land' || kind === 'signage') return lease === 'bare_land';
  if (kind === 'farm') return lease === 'agricultural';
  if (isIndustrial(kind)) return lease === 'industrial';
  if (isCommercial(kind)) return lease === 'commercial' || lease === 'short_term';
  return lease === 'residential' || lease === 'short_term';
}
