import { sql } from 'drizzle-orm';
import {
  date,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * MONEY: every monetary column is `INTEGER` fils (1 JOD = 1000 fils).
 * INTEGER cap is 2_147_483_647 fils = 2_147_483.647 JOD (~2.1M JOD) per row.
 * Anything that can legitimately exceed that (org-wide rollups, statements)
 * must be computed with `SUM(...)::bigint` at query time, never stored per row.
 */
export const MONEY_COLUMN_CAP_FILS = 2_147_483_647;

/** UUID primary key, generated server-side (gen_random_uuid(), pgcrypto built into PG13+). */
export const pkId = () => uuid('id').primaryKey().defaultRandom();

/** created_at / updated_at as timestamptz. updated_at is maintained by the app.touch_updated_at() trigger. */
export const auditTimestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** ISO calendar date kept as a string ('YYYY-MM-DD') so it never timezone-shifts. */
export const isoDate = (name: string) => date(name, { mode: 'string' });

/** Billing period 'YYYY-MM', validated by a CHECK constraint in every table that stores one. */
export const periodRegexCheck = (name: string, column: string) =>
  sql`${sql.raw(`"${column}"`)} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`;

export const periodCheckName = (table: string) => `${table}_period_format_ck`;

/** Fixed-precision decimals used only for rates/scores/area, never for money. */
export const rate = (name: string, precision = 6, scale = 4) =>
  numeric(name, { precision, scale });

export const areaSqm = (name = 'area_sqm') => numeric(name, { precision: 8, scale: 2 });

/** jsonb helper with an explicit TS type and a literal SQL default. */
export const jsonbArray = <T>(name: string) =>
  jsonb(name).$type<T[]>().notNull().default(sql`'[]'::jsonb`);

export const jsonbObject = <T extends Record<string, unknown>>(name: string) =>
  jsonb(name).$type<T>().notNull().default(sql`'{}'::jsonb`);

/** Small helper for non-negative money CHECK constraints. */
export const nonNegative = (column: string) => sql`${sql.raw(`"${column}"`)} >= 0`;

export const positive = (column: string) => sql`${sql.raw(`"${column}"`)} > 0`;

export { integer, text, timestamp, uuid };
