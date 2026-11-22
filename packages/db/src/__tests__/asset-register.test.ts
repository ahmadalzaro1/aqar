/**
 * 0018 — asset register, checked against a real Postgres.
 *
 * The migration and the Drizzle schema are two descriptions of one contract. TypeScript
 * can only prove the schema agrees with itself; only a database that has *run* the
 * migration can prove they agree with each other. So this file replays the migrations on
 * a clean schema and then measures:
 *
 *   - every enum's labels, in order, match the `pgEnum` tuples exactly;
 *   - the register is isolated per organisation and fails closed;
 *   - history is append-only for the application role, enforced by the database and not
 *     by convention;
 *   - the scope CHECK refuses an asset that names both a unit and a building.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { withOrganization } from '../client.js';
import { createDb, type Db } from '../client.js';
import {
  assets,
  assetEvents,
  equipmentEventKindEnum,
  equipmentEventSourceEnum,
  equipmentKindEnum,
  equipmentScopeEnum,
  equipmentSensitivityEnum,
  equipmentStatusEnum,
} from '../schema/index.js';
import { APP_URL, TEST_URL, createFixture, resetSchema, type Fixture } from './helpers.js';

let sql: postgres.Sql;
let appSql: postgres.Sql;
let appDb: Db;

/** Ordered labels of a Postgres enum type, or [] when the type does not exist. */
async function dbEnumLabels(name: string): Promise<string[]> {
  const rows = await sql<{ enumlabel: string }[]>`
    select e.enumlabel
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = ${name} and n.nspname = 'public'
    order by e.enumsortorder`;
  return rows.map((r) => r.enumlabel);
}

/** Insert one in-service asset at building scope (no unit) and return its id. */
async function insertAsset(f: Fixture, kind: string): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into assets (id, organization_id, property_id, scope, kind, label, building_id)
    values (${id}, ${f.orgId}, ${f.propertyId}, 'building', ${kind}, ${'Asset ' + kind},
            (select building_id from units where id = ${f.unitId}))`;
  return id;
}

beforeAll(async () => {
  await resetSchema();
  sql = postgres(TEST_URL, { max: 4, prepare: false });
  appSql = postgres(APP_URL, { max: 2, prepare: false });
  appDb = createDb(APP_URL, 2).db;
}, 120_000);

afterAll(async () => {
  await appSql?.end({ timeout: 5 });
  await sql?.end({ timeout: 5 });
});

describe('(1) schema parity: the migration is what the schema says it is', () => {
  const enums: readonly [string, { enumValues: readonly string[] }][] = [
    ['equipment_kind', equipmentKindEnum],
    ['equipment_scope', equipmentScopeEnum],
    ['equipment_status', equipmentStatusEnum],
    ['equipment_sensitivity', equipmentSensitivityEnum],
    ['equipment_event_kind', equipmentEventKindEnum],
    ['equipment_event_source', equipmentEventSourceEnum],
  ];

  for (const [name, enumDef] of enums) {
    it(`${name} has exactly the labels the schema declares, in order`, async () => {
      const labels = await dbEnumLabels(name);
      expect(labels).toEqual([...enumDef.enumValues]);
    });
  }

  it('registers all 32 equipment kinds — the count the dispatch map joins against', async () => {
    expect(await dbEnumLabels('equipment_kind')).toHaveLength(32);
  });

  it('creates both tables with the columns the schema exposes', async () => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name in ('assets', 'asset_events')`;
    const assetCols = new Set(
      cols.filter((c) => c.table_name === 'assets').map((c) => c.column_name),
    );
    const eventCols = new Set(
      cols.filter((c) => c.table_name === 'asset_events').map((c) => c.column_name),
    );

    // `assets` also carries Drizzle table options (`enableRLS`) that are not columns. A
    // real column exposes `columnType`; a table option does not.
    const schemaColumns = Object.values(assets)
      .filter((value) => typeof (value as { columnType?: unknown }).columnType === 'string')
      .map((value) => (value as { name: string }).name);
    // Guard against a vacuous pass: the loop below means nothing if the filter caught nothing.
    expect(schemaColumns.length).toBeGreaterThan(15);
    for (const column of schemaColumns) {
      expect(assetCols.has(column)).toBe(true);
    }
    // next_due_on is derived in the database, so it must exist there even though no
    // application code ever writes it.
    expect(assetCols.has('next_due_on')).toBe(true);
    expect([...eventCols].sort()).toEqual(
      expect.arrayContaining(['asset_id', 'event_kind', 'occurred_on', 'source', 'cost_fils']),
    );
  });
});

describe('(2) isolation: the register fails closed', () => {
  it('shows an organisation only its own assets', async () => {
    const a = await createFixture(sql, `asset-a-${randomUUID().slice(0, 8)}`);
    const b = await createFixture(sql, `asset-b-${randomUUID().slice(0, 8)}`);
    const assetId = await insertAsset(a, 'elevator');

    const seenByA = await withOrganization(appDb, a.orgId, async (tx) =>
      tx.select({ id: assets.id, org: assets.organizationId }).from(assets),
    );
    expect(seenByA.map((r) => r.id)).toEqual([assetId]);

    const seenByB = await withOrganization(appDb, b.orgId, async (tx) =>
      tx.select({ id: assets.id }).from(assets),
    );
    expect(seenByB).toHaveLength(0);

    const unfiltered =
      await appSql`select count(*)::int as n from assets where organization_id = ${a.orgId}`;
    expect(unfiltered[0]?.n).toBe(0);
  });

  it('refuses an asset written into another organisation while scoped', async () => {
    const a = await createFixture(sql, `asset-x-${randomUUID().slice(0, 8)}`);
    const b = await createFixture(sql, `asset-y-${randomUUID().slice(0, 8)}`);

    await expect(
      withOrganization(appDb, a.orgId, async (tx) =>
        tx.insert(assets).values({
          id: randomUUID(),
          organizationId: b.orgId,
          propertyId: b.propertyId,
          scope: 'building',
          buildingId: b.unitId, // any uuid; WITH CHECK rejects before FK matters
          kind: 'pump',
          label: 'Smuggled',
        }),
      ),
    ).rejects.toThrow();
  });

  it('has row level security enabled and forced on both tables', async () => {
    const rows = await sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('assets', 'asset_events') order by relname`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });
});

describe('(3) history is append-only, enforced by the database', () => {
  it('accepts an event and then refuses to rewrite or delete it', async () => {
    const f = await createFixture(sql, `asset-e-${randomUUID().slice(0, 8)}`);
    const assetId = await insertAsset(f, 'water_tank');

    const eventId = randomUUID();
    await withOrganization(appDb, f.orgId, async (tx) =>
      tx.insert(assetEvents).values({
        id: eventId,
        organizationId: f.orgId,
        assetId,
        eventKind: 'serviced',
        occurredOn: '2026-11-22',
        noteMd: 'annual clean',
      }),
    );

    const seen = await withOrganization(appDb, f.orgId, async (tx) =>
      tx.select({ id: assetEvents.id }).from(assetEvents),
    );
    expect(seen.map((r) => r.id)).toContain(eventId);

    await expect(
      appSql`update asset_events set note_md = 'rewritten' where id = ${eventId}`,
    ).rejects.toThrow();
    // The application role cannot even reach the delete path.
    await expect(appSql`delete from asset_events where id = ${eventId}`).rejects.toThrow();

    const after = await sql`select note_md from asset_events where id = ${eventId}`;
    expect(after[0]?.note_md).toBe('annual clean');
  });
});

describe('(4) the register refuses a physically impossible asset', () => {
  it('rejects an asset that claims both unit and building scope', async () => {
    const f = await createFixture(sql, `asset-bad-${randomUUID().slice(0, 8)}`);
    await expect(
      sql`insert into assets (id, organization_id, property_id, scope, unit_id, building_id, kind, label)
          values (${randomUUID()}, ${f.orgId}, ${f.propertyId}, 'unit',
                  ${f.unitId},
                  (select building_id from units where id = ${f.unitId}), 'pump', 'Impossible')`,
    ).rejects.toThrow(/assets_scope_target_ck/);
  });

  it('rejects a blank label', async () => {
    const f = await createFixture(sql, `asset-blank-${randomUUID().slice(0, 8)}`);
    await expect(
      sql`insert into assets (id, organization_id, property_id, scope, building_id, kind, label)
          values (${randomUUID()}, ${f.orgId}, ${f.propertyId}, 'building',
                  (select building_id from units where id = ${f.unitId}), 'pump', '   ')`,
    ).rejects.toThrow(/assets_label_not_blank_ck/);
  });
});
