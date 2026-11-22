import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditTimestamps, pkId } from './common.js';
import { users } from './auth.js';
import { organizations } from './organizations.js';

/** M9 — saved list/filter state, private by default. */
export const savedViews = pgTable(
  'saved_views',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** module key, e.g. 'tickets' | 'arrears' | 'vendors' */
    module: text('module').notNull(),
    filters: jsonb('filters')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    isShared: boolean('is_shared').notNull().default(false),
    ...auditTimestamps(),
  },
  (t) => [
    index('saved_views_org_module_idx').on(t.organizationId, t.module),
    index('saved_views_user_idx').on(t.userId),
    check('saved_views_name_ck', sql`length(btrim(${t.name})) > 0`),
  ],
);

/** M9 — recurring report definition (cron string + recipients, no wall-clock reads here). */
export const scheduledReports = pgTable(
  'scheduled_reports',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    cron: text('cron').notNull(),
    recipients: jsonb('recipients')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('scheduled_reports_org_idx').on(t.organizationId),
    index('scheduled_reports_active_idx').on(t.organizationId, t.isActive),
    check('scheduled_reports_cron_ck', sql`length(btrim(${t.cron})) >= 5`),
  ],
);
