import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, isoDate, nonNegative, pkId } from './common.js';
import { responsibilityEnum } from './enums.js';
import { buildings, properties, units } from './m1-property.js';
import { organizations } from './organizations.js';
import { tickets } from './m5-maintenance.js';
import { vendors } from './vendors.js';

/** What kind of equipment this row describes. Property `asset_kind` (land|building) is a different axis. */
export const equipmentKindEnum = pgEnum('equipment_kind', [
  'structure',
  'roof',
  'envelope',
  'water_supply',
  'water_tank',
  'pump',
  'drainage',
  'sewer',
  'gas_network',
  'gas_cylinder',
  'electrical_panel',
  'wiring',
  'generator',
  'solar',
  'hvac_split',
  'hvac_central',
  'water_heater',
  'elevator',
  'fire_alarm',
  'fire_extinguisher',
  'fire_riser',
  'security_access',
  'cctv',
  'intercom',
  'door_lock',
  'kitchen',
  'appliance',
  'plumbing_fixture',
  'lighting',
  'parking_equipment',
  'signage',
  'other',
]);

/** An asset serves one unit (private) or the building (shared, apportioned). */
export const equipmentScopeEnum = pgEnum('equipment_scope', ['unit', 'building']);
export const equipmentStatusEnum = pgEnum('equipment_status', [
  'in_service',
  'faulty',
  'retired',
  'replaced',
]);

/**
 * internal — staff and agent surfaces only.
 * tenant_visible — may be shown in the tenant's channel. Defaults to internal: fail closed.
 */
export const equipmentSensitivityEnum = pgEnum('equipment_sensitivity', [
  'internal',
  'tenant_visible',
]);

export const equipmentEventKindEnum = pgEnum('equipment_event_kind', [
  'installed',
  'serviced',
  'inspected',
  'failed',
  'repaired',
  'replaced',
  'warranty_claim',
  'retired',
]);

export const equipmentEventSourceEnum = pgEnum('equipment_event_source', [
  'manual',
  'ticket',
  'vendor',
  'schedule',
  'import',
]);

/**
 * M1/M5 — the building's digital twin: what is installed, where, since when,
 * under which warranty and service cycle, and who carries it by default.
 *
 * Privacy: this table holds no person data by design. Tenant identity lives on
 * leases/tickets; the register references `unit_id`, never a person.
 */
export const assets = pgTable(
  'assets',
  {
    ...auditTimestamps(),
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    scope: equipmentScopeEnum('scope').notNull(),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }),
    buildingId: uuid('building_id').references(() => buildings.id, { onDelete: 'cascade' }),
    kind: equipmentKindEnum('kind').notNull(),
    label: text('label').notNull(),
    serial: text('serial'),
    installedOn: isoDate('installed_on'),
    expectedLifeYears: integer('expected_life_years'),
    warrantyExpiresOn: isoDate('warranty_expires_on'),
    serviceIntervalDays: integer('service_interval_days'),
    lastServicedOn: isoDate('last_serviced_on'),
    nextDueOn: isoDate('next_due_on').generatedAlwaysAs(
      sql`last_serviced_on + service_interval_days`,
    ),
    responsibleParty: responsibilityEnum('responsible_party').notNull().default('landlord'),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    costCentre: text('cost_centre'),
    status: equipmentStatusEnum('status').notNull().default('in_service'),
    sensitivity: equipmentSensitivityEnum('sensitivity').notNull().default('internal'),
    replacedByAssetId: uuid('replaced_by_asset_id').references((): AnyPgColumn => assets.id, {
      onDelete: 'set null',
    }),
    notesMd: text('notes_md'),
  },
  (t) => [
    uniqueIndex('assets_serial_uq')
      .on(t.organizationId, t.serial)
      .where(sql`${t.serial} is not null`),
    index('assets_property_idx').on(t.organizationId, t.propertyId),
    index('assets_unit_idx')
      .on(t.unitId)
      .where(sql`${t.unitId} is not null`),
    index('assets_building_idx')
      .on(t.buildingId)
      .where(sql`${t.buildingId} is not null`),
    index('assets_due_idx')
      .on(t.organizationId, t.nextDueOn)
      .where(sql`${t.status} = 'in_service' and ${t.nextDueOn} is not null`),
    check('assets_label_not_blank_ck', sql`length(btrim(${t.label})) > 0`),
    check(
      'assets_scope_target_ck',
      sql`(${t.scope} = 'unit' and ${t.unitId} is not null and ${t.buildingId} is null)
          or (${t.scope} = 'building' and ${t.buildingId} is not null and ${t.unitId} is null)`,
    ),
    check(
      'assets_expected_life_ck',
      sql`${t.expectedLifeYears} is null or ${t.expectedLifeYears} between 1 and 100`,
    ),
    check(
      'assets_service_interval_ck',
      sql`${t.serviceIntervalDays} is null or ${t.serviceIntervalDays} between 1 and 3650`,
    ),
    check(
      'assets_life_dates_ck',
      sql`${t.installedOn} is null or ${t.warrantyExpiresOn} is null
          or ${t.warrantyExpiresOn} >= ${t.installedOn}`,
    ),
    check(
      'assets_service_dates_ck',
      sql`${t.installedOn} is null or ${t.lastServicedOn} is null
          or ${t.lastServicedOn} >= ${t.installedOn}`,
    ),
    check('assets_no_self_replace_ck', sql`${t.replacedByAssetId} is distinct from ${t.id}`),
    check(
      'assets_replaced_consistency_ck',
      sql`${t.status} <> 'replaced' or ${t.replacedByAssetId} is not null`,
    ),
  ],
);

/**
 * The register's time axis. Append-only: UPDATE and DELETE are refused by
 * `app.assert_asset_event_append_only()`, and aqar_app holds only SELECT/INSERT.
 *
 * There is deliberately no tenant_id column: erasing a tenant must not erase
 * the building's repair history. Provenance points at the ticket instead.
 */
export const assetEvents = pgTable(
  'asset_events',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    eventKind: equipmentEventKindEnum('event_kind').notNull(),
    occurredOn: isoDate('occurred_on').notNull(),
    source: equipmentEventSourceEnum('source').notNull().default('manual'),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    costFils: bigint('cost_fils', { mode: 'number' }),
    evidenceRef: text('evidence_ref'),
    noteMd: text('note_md'),
    recordedByUserId: uuid('recorded_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('asset_events_asset_idx').on(t.assetId, t.occurredOn),
    index('asset_events_org_idx').on(t.organizationId, t.occurredOn),
    index('asset_events_ticket_idx')
      .on(t.ticketId)
      .where(sql`${t.ticketId} is not null`),
    check('asset_events_cost_ck', sql`${t.costFils} is null or ${nonNegative('cost_fils')}`),
  ],
);

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type AssetEvent = typeof assetEvents.$inferSelect;
export type NewAssetEvent = typeof assetEvents.$inferInsert;
