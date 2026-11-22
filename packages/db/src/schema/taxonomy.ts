import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditTimestamps } from './common.js';
import { units } from './m1-property.js';

/**
 * The asset/space taxonomy added by migrations 0008 and 0009.
 *
 * Enum labels are ordered exactly as the Postgres types are: `space_kind` in the
 * order a human would read them, and the drift test in `apps/worker` asserts the
 * two lists stay identical, value by value.
 */

export const assetKindEnum = pgEnum('asset_kind', [
  'parcel',
  'building',
  'compound',
  'tower',
  'farm',
  'mixed_use',
  'infrastructure',
]);

export const spaceKindEnum = pgEnum('space_kind', [
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
]);

export const leaseKindEnum = pgEnum('lease_kind', [
  'residential',
  'commercial',
  'industrial',
  'agricultural',
  'short_term',
  'parking',
  'bare_land',
]);

export const billingCycleEnum = pgEnum('billing_cycle', [
  'monthly',
  'quarterly',
  'semi_annual',
  'annual',
  'upfront_single',
]);

/**
 * Kind-specific attributes live in 1:1 tables, not in a JSONB blob, because each
 * one is a number a lease may reference or a tenant negotiates. A trigger
 * (`unit_detail_kind_guard`, migration 0009) refuses a detail row whose unit is
 * not of that family — a check no blob column can express.
 */

export const unitResidentialDetail = pgTable('unit_residential_detail', {
  unitId: uuid('unit_id')
    .primaryKey()
    .references(() => units.id, { onDelete: 'cascade' }),
  squareM: numeric('square_m'),
  furnished: boolean('furnished').notNull().default(false),
  hasBalcony: boolean('has_balcony').notNull().default(false),
  hasParking: boolean('has_parking').notNull().default(false),
  floorNumber: integer('floor_number'),
  ...auditTimestamps(),
});

export const unitCommercialDetail = pgTable(
  'unit_commercial_detail',
  {
    unitId: uuid('unit_id')
      .primaryKey()
      .references(() => units.id, { onDelete: 'cascade' }),
    frontageM: numeric('frontage_m'),
    displayWindows: integer('display_windows').notNull().default(0),
    rollerShutter: boolean('roller_shutter').notNull().default(true),
    mezzanineSqm: numeric('mezzanine_sqm'),
    // What the space was built and approved for.
    permittedUse: text('permitted_use'),
    // What the current tenant is licensed to trade. Distinct on purpose: a shop
    // approved for retail and licensed as a restaurant is a real difference, and
    // the lease, the fit-out and the municipality all care about it.
    licensedUse: text('licensed_use'),
    powerCapacityKva: numeric('power_capacity_kva'),
    hasFireSystem: boolean('has_fire_system').notNull().default(false),
    fitOut: text('fit_out'),
    ...auditTimestamps(),
  },
  (t) => [
    check(
      'unit_commercial_fit_out_ck',
      sql`${t.fitOut} IS NULL OR ${t.fitOut} IN ('shell','semi_fitted','fitted','turnkey')`,
    ),
    check('unit_commercial_windows_ck', sql`${t.displayWindows} >= 0`),
    check(
      'unit_commercial_power_ck',
      sql`${t.powerCapacityKva} IS NULL OR ${t.powerCapacityKva} > 0`,
    ),
  ],
);

export const unitIndustrialDetail = pgTable(
  'unit_industrial_detail',
  {
    unitId: uuid('unit_id')
      .primaryKey()
      .references(() => units.id, { onDelete: 'cascade' }),
    clearHeightM: numeric('clear_height_m'),
    floorLoadKgSqm: integer('floor_load_kg_sqm'),
    dockDoors: integer('dock_doors').notNull().default(0),
    threePhasePower: boolean('three_phase_power').notNull().default(false),
    yardSqm: numeric('yard_sqm'),
    temperatureC: integer('temperature_c'),
    permittedUse: text('permitted_use'),
    licensedUse: text('licensed_use'),
    powerCapacityKva: numeric('power_capacity_kva'),
    hasFireSystem: boolean('has_fire_system').notNull().default(false),
    ...auditTimestamps(),
  },
  (t) => [
    check('unit_industrial_docks_ck', sql`${t.dockDoors} >= 0`),
    check(
      'unit_industrial_power_ck',
      sql`${t.powerCapacityKva} IS NULL OR ${t.powerCapacityKva} > 0`,
    ),
  ],
);

export const unitLandDetail = pgTable(
  'unit_land_detail',
  {
    unitId: uuid('unit_id')
      .primaryKey()
      .references(() => units.id, { onDelete: 'cascade' }),
    // A plot number is only unique inside its basin (DLS حوض); the pair is the
    // parcel's identity, and the deed lookup needs both.
    plotNumber: text('plot_number'),
    basin: text('basin'),
    plotAreaSqm: numeric('plot_area_sqm'),
    maxFar: numeric('max_far'),
    maxHeightM: numeric('max_height_m'),
    zoningPermitRef: text('zoning_permit_ref'),
    // What the setback rules allow, and the road that sets them.
    setbackFrontM: numeric('setback_front_m'),
    setbackSideM: numeric('setback_side_m'),
    setbackRearM: numeric('setback_rear_m'),
    roadWidthM: numeric('road_width_m'),
    // An encumbered plot cannot be sold clean or mortgaged; the lease must say so.
    hasLien: boolean('has_lien').notNull().default(false),
    isCorner: boolean('is_corner').notNull().default(false),
    hasWaterMeter: boolean('has_water_meter').notNull().default(false),
    hasPowerMeter: boolean('has_power_meter').notNull().default(false),
    currentUse: text('current_use'),
    ...auditTimestamps(),
  },
  (t) => [
    check(
      'unit_land_setbacks_ck',
      sql`(${t.setbackFrontM} IS NULL OR ${t.setbackFrontM} >= 0)
        AND (${t.setbackSideM} IS NULL OR ${t.setbackSideM} >= 0)
        AND (${t.setbackRearM} IS NULL OR ${t.setbackRearM} >= 0)
        AND (${t.roadWidthM} IS NULL OR ${t.roadWidthM} > 0)`,
    ),
  ],
);

export const unitFarmDetail = pgTable('unit_farm_detail', {
  unitId: uuid('unit_id')
    .primaryKey()
    .references(() => units.id, { onDelete: 'cascade' }),
  areaDunums: numeric('area_dunums'),
  wellCount: integer('well_count').notNull().default(0),
  waterRightsM3: numeric('water_rights_m3'),
  greenhouseCount: integer('greenhouse_count').notNull().default(0),
  soilKind: text('soil_kind'),
  plantedCrop: text('planted_crop'),
  ...auditTimestamps(),
});

export const unitRooftopDetail = pgTable('unit_rooftop_detail', {
  unitId: uuid('unit_id')
    .primaryKey()
    .references(() => units.id, { onDelete: 'cascade' }),
  loadCapacityKgSqm: integer('load_capacity_kg_sqm'),
  accessKind: text('access_kind'),
  hasParapet: boolean('has_parapet').notNull().default(false),
  ...auditTimestamps(),
});

/**
 * A parking bay is a product with its own numbers. It used to live in
 * `unit_land_detail`, where it could only store a plot number and a FAR — neither
 * of which a bay has. Its real question is "does my car fit", and the answer is
 * width, length and door clearance.
 */
export const unitParkingDetail = pgTable(
  'unit_parking_detail',
  {
    unitId: uuid('unit_id')
      .primaryKey()
      .references(() => units.id, { onDelete: 'cascade' }),
    level: text('level'),
    bayWidthM: numeric('bay_width_m'),
    bayLengthM: numeric('bay_length_m'),
    // Door height, not ceiling height: an SUV needs more than a saloon.
    clearanceM: numeric('clearance_m'),
    isCovered: boolean('is_covered').notNull().default(false),
    // Granted by the building, or owned outright under its own deed. Mutually
    // exclusive: a bay held on title is not allocated from a pool.
    isAllocated: boolean('is_allocated').notNull().default(true),
    hasOwnDeed: boolean('has_own_deed').notNull().default(false),
    hasEvCharger: boolean('has_ev_charger').notNull().default(false),
    // The flat this bay serves. This link is what a tenant disputes, so a trigger
    // (unit_parking_allocation_guard) refuses one that crosses a property or
    // building boundary, or that points at another bay.
    allocatedToUnitId: uuid('allocated_to_unit_id').references(() => units.id, {
      onDelete: 'set null',
    }),
    ...auditTimestamps(),
  },
  (t) => [
    check(
      'unit_parking_dims_ck',
      sql`(${t.bayWidthM} IS NULL OR ${t.bayWidthM} > 0)
        AND (${t.bayLengthM} IS NULL OR ${t.bayLengthM} > 0)
        AND (${t.clearanceM} IS NULL OR ${t.clearanceM} > 0)`,
    ),
    check('unit_parking_allocation_ck', sql`${t.allocatedToUnitId} IS NULL OR ${t.isAllocated}`),
    check('unit_parking_deed_ck', sql`NOT (${t.isAllocated} AND ${t.hasOwnDeed})`),
    index('unit_parking_allocated_to_idx').on(t.allocatedToUnitId),
  ],
);

/**
 * A billboard is sold on face area, orientation and whether it is lit — none of
 * which a plot, a bedroom count or a FAR describes.
 */
export const unitSignageDetail = pgTable(
  'unit_signage_detail',
  {
    unitId: uuid('unit_id')
      .primaryKey()
      .references(() => units.id, { onDelete: 'cascade' }),
    faceAreaSqm: numeric('face_area_sqm'),
    orientation: text('orientation'),
    permitRef: text('permit_ref'),
    isIlluminated: boolean('is_illuminated').notNull().default(false),
    ...auditTimestamps(),
  },
  (t) => [
    check('unit_signage_face_ck', sql`${t.faceAreaSqm} IS NULL OR ${t.faceAreaSqm} > 0`),
    check(
      'unit_signage_orientation_ck',
      sql`${t.orientation} IS NULL OR ${t.orientation} IN (
        'north','south','east','west',
        'north_east','north_west','south_east','south_west','multi'
      )`,
    ),
  ],
);

export const taxonomyTables = [
  unitResidentialDetail,
  unitCommercialDetail,
  unitIndustrialDetail,
  unitLandDetail,
  unitFarmDetail,
  unitRooftopDetail,
  unitParkingDetail,
  unitSignageDetail,
] as const;
