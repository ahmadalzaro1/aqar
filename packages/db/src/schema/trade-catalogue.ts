import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
} from 'drizzle-orm/pg-core';
import { TRADE_TOKENS, type Trade } from '@aqar/core';
import { equipmentKindEnum } from './m1-assets.js';

/**
 * The trade vocabulary, in the database.
 *
 * Until now `vendors.trades` was untyped jsonb of strings, so any word could be
 * written and nothing could be joined against it. This enum is generated from
 * the same `TRADE_TOKENS` list core uses, and the reference tables below are
 * keyed by it — one vocabulary, enforced by the type system at both ends.
 */
export const vendorTradeEnum = pgEnum('vendor_trade', [...TRADE_TOKENS] as [Trade, ...Trade[]]);

/**
 * Which trade looks after which kind of asset. Reference data, not tenant data:
 * it is the same map for every organisation, so it carries no `organization_id`
 * and no RLS policy. `priority` orders the trades that may answer; 0 is primary.
 */
export const equipmentTradeMap = pgTable(
  'equipment_trade_map',
  {
    equipmentKind: equipmentKindEnum('equipment_kind').notNull(),
    trade: vendorTradeEnum('trade').notNull(),
    priority: smallint('priority').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.equipmentKind, t.trade] }),
    index('equipment_trade_map_trade_idx').on(t.trade),
    check('equipment_trade_map_priority_ck', sql`${t.priority} >= 0`),
  ],
);

/**
 * What a trade does on a cadence. `cadence_days IS NULL` means the job only
 * exists when something fails. `cadence_basis` says where the number came from,
 * so a statutory interval can be told apart from a manufacturer's suggestion and
 * from our own judgement — the last two are safe to change, the first is not.
 */
export const tradeJobTemplates = pgTable(
  'trade_job_templates',
  {
    code: text('code').primaryKey(),
    trade: vendorTradeEnum('trade').notNull(),
    titleEn: text('title_en').notNull(),
    titleAr: text('title_ar').notNull(),
    cadenceDays: integer('cadence_days'),
    cadenceBasis: text('cadence_basis'),
    statutory: boolean('statutory').notNull().default(false),
    statutoryAuthority: text('statutory_authority'),
    requiresCertificate: boolean('requires_certificate').notNull().default(false),
    equipmentKinds: equipmentKindEnum('equipment_kinds')
      .array()
      .notNull()
      .default(sql`'{}'::"equipment_kind"[]`),
    notes: text('notes'),
  },
  (t) => [
    index('trade_job_templates_trade_idx').on(t.trade),
    check('trade_job_templates_cadence_ck', sql`${t.cadenceDays} IS NULL OR ${t.cadenceDays} > 0`),
    check(
      'trade_job_templates_basis_ck',
      sql`(${t.cadenceDays} IS NULL) = (${t.cadenceBasis} IS NULL)`,
    ),
    check(
      'trade_job_templates_basis_value_ck',
      sql`${t.cadenceBasis} IS NULL OR ${t.cadenceBasis} IN ('statutory', 'manufacturer', 'recommended')`,
    ),
    // A statute without an authority is a rumour.
    check(
      'trade_job_templates_statutory_ck',
      sql`NOT ${t.statutory} OR (${t.statutoryAuthority} IS NOT NULL AND ${t.cadenceBasis} = 'statutory')`,
    ),
  ],
);
