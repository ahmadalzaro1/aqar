import { sql } from 'drizzle-orm';
import { boolean, check, integer, numeric, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
    permittedUse: text('permitted_use'),
    fitOut: text('fit_out'),
    ...auditTimestamps(),
  },
  (t) => [
    check(
      'unit_commercial_fit_out_ck',
      sql`${t.fitOut} IS NULL OR ${t.fitOut} IN ('shell','semi_fitted','fitted','turnkey')`,
    ),
    check('unit_commercial_windows_ck', sql`${t.displayWindows} >= 0`),
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
    ...auditTimestamps(),
  },
  (t) => [check('unit_industrial_docks_ck', sql`${t.dockDoors} >= 0`)],
);

export const unitLandDetail = pgTable('unit_land_detail', {
  unitId: uuid('unit_id')
    .primaryKey()
    .references(() => units.id, { onDelete: 'cascade' }),
  plotNumber: text('plot_number'),
  plotAreaSqm: numeric('plot_area_sqm'),
  maxFar: numeric('max_far'),
  maxHeightM: numeric('max_height_m'),
  isCorner: boolean('is_corner').notNull().default(false),
  hasWaterMeter: boolean('has_water_meter').notNull().default(false),
  hasPowerMeter: boolean('has_power_meter').notNull().default(false),
  currentUse: text('current_use'),
  ...auditTimestamps(),
});

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

export const taxonomyTables = [
  unitResidentialDetail,
  unitCommercialDetail,
  unitIndustrialDetail,
  unitLandDetail,
  unitFarmDetail,
  unitRooftopDetail,
] as const;
