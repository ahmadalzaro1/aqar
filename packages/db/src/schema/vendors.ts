import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, isoDate, pkId } from './common.js';
import { organizations } from './organizations.js';

export type VendorTrade =
  | 'plumbing'
  | 'electrical'
  | 'hvac'
  | 'gas'
  | 'elevator'
  | 'cleaning'
  | 'carpentry'
  | 'pest'
  | 'appliance'
  | 'generator'
  | 'painting'
  | 'locksmith'
  | 'structural';

export type VendorRates = {
  calloutFils: number;
  hourlyFils: number;
  /** emergency uplift in basis points, 2500 = +25% */
  emergencyMultiplierBps: number;
};

export type CoverageArea = { city: string; district: string | null };

/**
 * M6 — approved service vendor. Lives in its own module so M5 (tickets) and M6
 * (vendor operations) can both reference it without an import cycle.
 */
export const vendors = pgTable(
  'vendors',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    trades: jsonb('trades')
      .$type<VendorTrade[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    coverageAreas: jsonb('coverage_areas')
      .$type<CoverageArea[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    rates: jsonb('rates')
      .$type<VendorRates>()
      .notNull()
      .default(sql`'{"calloutFils":0,"hourlyFils":0,"emergencyMultiplierBps":0}'::jsonb`),
    /** null = no insurance on file. Expiry drives a compliance reminder. */
    insuranceCertExpiry: isoDate('insurance_cert_expiry'),
    licence: text('licence'),
    rating: numeric('rating', { precision: 3, scale: 2 }),
    /** agent policy may only award work to allow-listed vendors */
    allowListed: boolean('allow_listed').notNull().default(false),
    notes: text('notes'),
    ...auditTimestamps(),
  },
  (t) => [
    index('vendors_org_idx').on(t.organizationId),
    uniqueIndex('vendors_org_name_uq').on(t.organizationId, t.nameEn),
    check('vendors_rating_ck', sql`${t.rating} IS NULL OR (${t.rating} >= 0 AND ${t.rating} <= 5)`),
    check(
      'vendors_rates_ck',
      sql`(${t.rates} ->> 'calloutFils')::int >= 0 AND (${t.rates} ->> 'hourlyFils')::int >= 0`,
    ),
  ],
);
