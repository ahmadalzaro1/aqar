import type { SharedAllocationMode } from '@aqar/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, areaSqm, isoDate, pkId } from './common.js';
import { meterKindEnum, unitStatusEnum } from './enums.js';
import { organizations } from './organizations.js';

/** How shared building services (generator, water tank, cleaning) are split across units. */
export type SharedServicesConfig = {
  allocationMode: SharedAllocationMode;
  items: { code: string; nameEn: string; nameAr: string; monthlyFils: number }[];
};

/**
 * M1 — a property is a building group at one Jordanian address
 * (district + building name + optional street; no US-style street/ZIP line).
 */
export const properties = pgTable(
  'properties',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameAr: text('name_ar').notNull(),
    district: text('district').notNull(),
    buildingName: text('building_name'),
    street: text('street'),
    city: text('city').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    sharedServicesConfig: jsonb('shared_services_config')
      .$type<SharedServicesConfig>()
      .notNull()
      .default(sql`'{"allocationMode":"per_unit","items":[]}'::jsonb`),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('properties_org_idx').on(t.organizationId),
    index('properties_city_district_idx').on(t.city, t.district),
    check(
      'properties_lat_ck',
      sql`${t.lat} IS NULL OR (${t.lat} >= -90 AND ${t.lat} <= 90)`,
    ),
    check(
      'properties_lng_ck',
      sql`${t.lng} IS NULL OR (${t.lng} >= -180 AND ${t.lng} <= 180)`,
    ),
  ],
);

export const buildings = pgTable(
  'buildings',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameAr: text('name_ar').notNull(),
    floors: integer('floors').notNull().default(1),
    yearBuilt: integer('year_built'),
    elevator: boolean('elevator').notNull().default(false),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('buildings_org_idx').on(t.organizationId),
    index('buildings_property_idx').on(t.propertyId),
    check('buildings_floors_ck', sql`${t.floors} > 0`),
    check(
      'buildings_year_built_ck',
      sql`${t.yearBuilt} IS NULL OR (${t.yearBuilt} >= 1900 AND ${t.yearBuilt} <= 2100)`,
    ),
  ],
);

/**
 * M1 — rentable unit. `propertyId` is carried alongside `buildingId` so every
 * cross-module query can filter by property without a join; the FK keeps it honest.
 */
export const units = pgTable(
  'units',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    buildingId: uuid('building_id')
      .notNull()
      .references(() => buildings.id, { onDelete: 'cascade' }),
    unitNumber: text('unit_number').notNull(),
    floor: text('floor'),
    bedrooms: integer('bedrooms').notNull().default(1),
    bathrooms: integer('bathrooms').notNull().default(1),
    areaSqm: areaSqm(),
    /** Asking rent for the unit in fils; the lease is the binding figure. */
    marketRentFils: integer('market_rent_fils').notNull(),
    status: unitStatusEnum('status').notNull().default('vacant'),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('units_org_idx').on(t.organizationId),
    index('units_property_idx').on(t.propertyId),
    index('units_status_idx').on(t.organizationId, t.status),
    uniqueIndex('units_building_number_uq').on(t.buildingId, t.unitNumber),
    check('units_bedrooms_ck', sql`${t.bedrooms} >= 0`),
    check('units_bathrooms_ck', sql`${t.bathrooms} >= 0`),
    check('units_market_rent_ck', sql`${t.marketRentFils} >= 0`),
    check('units_area_ck', sql`${t.areaSqm} IS NULL OR ${t.areaSqm} > 0`),
  ],
);

export const amenities = pgTable(
  'amenities',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    buildingId: uuid('building_id').references(() => buildings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    /** true = bundled into rent, false = separately chargeable service. */
    includedInRent: boolean('included_in_rent').notNull().default(true),
    monthlyFils: integer('monthly_fils').notNull().default(0),
    ...auditTimestamps(),
  },
  (t) => [
    index('amenities_org_idx').on(t.organizationId),
    index('amenities_property_idx').on(t.propertyId),
    uniqueIndex('amenities_property_code_uq').on(t.propertyId, t.code),
    check('amenities_monthly_fils_ck', sql`${t.monthlyFils} >= 0`),
  ],
);

/** Amenity availability per unit. */
export const unitAmenities = pgTable(
  'unit_amenities',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'cascade' }),
    amenityId: uuid('amenity_id')
      .notNull()
      .references(() => amenities.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.unitId, t.amenityId] }),
    index('unit_amenities_org_idx').on(t.organizationId),
  ],
);

/** Sub-meters: water tanks, electricity, building generator. */
export const meters = pgTable(
  'meters',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }),
    kind: meterKindEnum('kind').notNull(),
    serialNumber: text('serial_number').notNull(),
    meterNumber: text('meter_number'),
    lastReading: integer('last_reading'),
    lastReadingAt: isoDate('last_reading_at'),
    /** tariff shape is provider-specific; kept as jsonb rather than guessed columns. */
    tariff: jsonb('tariff').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    ...auditTimestamps(),
  },
  (t) => [
    index('meters_org_idx').on(t.organizationId),
    index('meters_property_idx').on(t.propertyId),
    index('meters_unit_idx').on(t.unitId),
    uniqueIndex('meters_org_serial_uq').on(t.organizationId, t.serialNumber),
    check('meters_reading_ck', sql`${t.lastReading} IS NULL OR ${t.lastReading} >= 0`),
  ],
);
