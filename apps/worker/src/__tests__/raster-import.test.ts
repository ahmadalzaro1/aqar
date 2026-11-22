import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importRasterPlan } from '@aqar/drawings';
import { createSql, type Sql } from '@aqar/db';

/**
 * The raster lane, exercised against the real database.
 *
 * The rule under test is the one that separates this lane from the vector one:
 * pixels are testimony. A claim is stored with its confidence, a claim below the
 * floor is recorded and refused, and nothing here can overwrite a confirmation.
 */

const databaseUrl = process.env['DATABASE_URL'];
const maybe = databaseUrl === undefined ? describe.skip : describe;

const FIXTURE = resolve(process.cwd(), '../../tools/plan-extractor/fixtures/flats-raster.json');

let sql: Sql;
let orgId: string;
let propertyId: string;
let userId: string;

maybe('a segmentation result becomes testimony, not a charge', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('unreachable');
    sql = createSql(databaseUrl);
    const orgs = await sql<{ id: string }[]>`select id from organizations where slug = 'aqar-demo'`;
    const org = orgs[0];
    if (org === undefined) throw new Error('seeded organization missing');
    orgId = org.id;

    const users = await sql<{ id: string }[]>`
      select id from users where organization_id = ${orgId}::uuid order by created_at limit 1`;
    const user = users[0];
    if (user === undefined) throw new Error('seeded user missing');
    userId = user.id;

    // A property of its own: this suite must never depend on, or damage, the seeded ones.
    const created = await sql<{ id: string }[]>`
      insert into properties (organization_id, name, name_ar, district, city, asset_kind, zoning)
      values (${orgId}::uuid, ${`Raster Fixture ${randomUUID().slice(0, 8)}`},
              'عقار تجريبي', 'Jabal Al-Weibdeh', 'Amman', 'building', 'residential')
      returning id`;
    const property = created[0];
    if (property === undefined) throw new Error('property insert returned no row');
    propertyId = property.id;
  });

  afterAll(async () => {
    if (sql === undefined) return;
    // Scoped to this suite's own property. An organisation-wide delete here wiped
    // every other plan's rooms the first time it ran — a test may clean up after
    // itself, never after the whole portfolio.
    await sql`
      delete from plan_rooms
       where floor_plan_id in (select id from floor_plans where property_id = ${propertyId}::uuid)`;
    await sql`delete from floor_plans where property_id = ${propertyId}::uuid`;
    await sql`delete from properties where id = ${propertyId}::uuid`;
    await sql.end();
  });

  it('measures the claims, stores the believable ones and names the refusals', async () => {
    const result = await importRasterPlan({
      filePath: FIXTURE,
      property: propertyId,
      level: 'ground',
      statedSqm: 123,
      databaseUrl: databaseUrl as string,
    });

    expect(result.claims).toBe(6);
    expect(result.accepted).toBe(4);
    expect(result.refused).toEqual([
      { code: 'R-105', flags: ['low_confidence'] },
      { code: 'R-106', flags: ['outside_image'] },
    ]);
    // 60 + 45 + 18 from the three flat rooms; the corridor is stored but is not
    // lettable, so it must not enter the reconciliation.
    expect(result.sumSqm).toBe(123);
    expect(result.reconciliation.verdict).toBe('within');

    const rooms = await sql<{ code: string; source: string; confidence: string | null }[]>`
      select code, source, confidence from plan_rooms
       where floor_plan_id = ${result.floorPlanId}::uuid order by code`;
    expect(rooms.map((room) => room.code)).toEqual(['R-101', 'R-102', 'R-103', 'R-104']);
    expect(rooms.every((room) => room.source === 'raster_model' && room.confidence !== null)).toBe(
      true,
    );
  });

  it('refuses to replace a plan whose room a person confirmed', async () => {
    const plans = await sql<{ id: string }[]>`
      select id from floor_plans where property_id = ${propertyId}::uuid and level = 'ground'`;
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');

    await sql`
      update plan_rooms set confirmed_by = ${userId}::uuid, confirmed_at = now()
       where floor_plan_id = ${plan.id}::uuid and code = 'R-101'`;

    // A different document for the same level: same level, new bytes.
    const raw = JSON.parse(await readFile(FIXTURE, 'utf8')) as Record<string, unknown>;
    const directory = await mkdtemp(join(tmpdir(), 'aqar-raster-'));
    const altered = join(directory, 'recalibrated.json');
    await writeFile(altered, JSON.stringify({ ...raw, metres_per_pixel: 0.0105 }));

    await expect(
      importRasterPlan({
        filePath: altered,
        property: propertyId,
        level: 'ground',
        statedSqm: 123,
        databaseUrl: databaseUrl as string,
      }),
    ).rejects.toThrow(/confirmed or materialised/);

    const survived = await sql<{ code: string; confirmed: boolean }[]>`
      select code, confirmed_by is not null as confirmed from plan_rooms
       where floor_plan_id = ${plan.id}::uuid and code = 'R-101'`;
    expect(survived[0]?.confirmed).toBe(true);
  });

  it('lets the database refuse a model room with no confidence', async () => {
    const plans = await sql<{ id: string }[]>`
      select id from floor_plans where property_id = ${propertyId}::uuid and level = 'ground'`;
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');

    await expect(
      sql`
        insert into plan_rooms (organization_id, floor_plan_id, code, room_kind, area_sqm,
                                polygon, source)
        values (${orgId}::uuid, ${plan.id}::uuid, 'R-999', 'unit', 12,
                ${JSON.stringify({
                  frame: 'pixels',
                  ring: [
                    [0, 0],
                    [10, 0],
                    [10, 10],
                  ],
                })}::jsonb,
                'raster_model')`,
    ).rejects.toThrow(/plan_rooms_confidence_ck/);
  });
});
