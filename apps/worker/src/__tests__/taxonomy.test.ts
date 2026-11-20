import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSET_KINDS,
  BILLING_CYCLES,
  CHARGE_KINDS,
  LEASE_KINDS,
  SPACE_KINDS,
  TICKET_CATEGORIES,
} from '@aqar/core';
import { createSql, type Sql } from '@aqar/db';

/**
 * The vocabulary exists twice on purpose: once as a Postgres enum (the database
 * must refuse a value the code cannot produce) and once as a TypeScript union
 * (the compiler must refuse it too). Two lists that are "kept in sync by
 * discipline" are two lists that diverge, so this test compares them value by
 * value, in both directions, against the live database.
 *
 * It lives in the worker because that is the only process that already depends on
 * both `@aqar/core` and a database connection.
 */

const databaseUrl = process.env['DATABASE_URL'];
const maybe = databaseUrl === undefined ? describe.skip : describe;

let sql: Sql;

maybe('taxonomy matches the live database', () => {
  beforeAll(() => {
    if (databaseUrl === undefined) throw new Error('unreachable');
    sql = createSql(databaseUrl);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function enumValues(name: string): Promise<string[]> {
    const rows = await sql<{ label: string }[]>`
      select e.enumlabel as label
        from pg_type t join pg_enum e on e.enumtypid = t.oid
       where t.typname = ${name}
       order by e.enumsortorder`;
    return rows.map((row) => row.label);
  }

  it('space_kind: same values, same order', async () => {
    expect(await enumValues('space_kind')).toEqual([...SPACE_KINDS]);
  });

  it('lease_kind: same values, same order', async () => {
    expect(await enumValues('lease_kind')).toEqual([...LEASE_KINDS]);
  });

  it('billing_cycle: same values, same order', async () => {
    expect(await enumValues('billing_cycle')).toEqual([...BILLING_CYCLES]);
  });

  it('asset_kind: same values, same order', async () => {
    expect(await enumValues('asset_kind')).toEqual([...ASSET_KINDS]);
  });

  it('charge_kind: every core kind exists in the database', async () => {
    const live = await enumValues('charge_kind');
    // The database may carry legacy values; the code may not invent one.
    for (const kind of CHARGE_KINDS) expect(live).toContain(kind);
  });

  it('ticket_category: every core category exists in the database', async () => {
    const live = await enumValues('ticket_category');
    for (const category of TICKET_CATEGORIES) expect(live).toContain(category);
  });
});
