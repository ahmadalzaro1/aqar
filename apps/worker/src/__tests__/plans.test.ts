import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSvgPlan, reconcileAreas } from '@aqar/core';
import { createSql, type Sql } from '@aqar/db';

/**
 * End to end for the round trip an operator actually performs: upload a
 * schematic, read its rooms, reconcile the total, and store it as evidence —
 * never as a charge.
 */

const databaseUrl = process.env['DATABASE_URL'];
const maybe = databaseUrl === undefined ? describe.skip : describe;

const FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg">
  <rect id="101" data-label="Flat 101" x="0" y="0" width="6000" height="10000" />
  <rect id="102" data-label="Flat 102" x="6000" y="0" width="4500" height="10000" />
  <polygon id="103" data-label="Flat 103" points="10500,0 16500,0 16500,3000 10500,3000" />
  <path id="arc" d="M 0 11000 C 500 11000 500 11500 0 11500 Z" />
</svg>`;

let sql: Sql;
let orgId: string;
let propertyId: string;
const planIds: string[] = [];

maybe('a schematic becomes reviewed geometry, not a charge', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('unreachable');
    sql = createSql(databaseUrl);
    const orgs = await sql<{ id: string }[]>`select id from organizations where slug = 'aqar-demo'`;
    const org = orgs[0];
    if (org === undefined) throw new Error('seeded organization missing');
    orgId = org.id;
    const properties = await sql<{ id: string }[]>`
      select id from properties where organization_id = ${orgId}::uuid order by created_at limit 1`;
    const property = properties[0];
    if (property === undefined) throw new Error('seeded property missing');
    propertyId = property.id;
  });

  afterAll(async () => {
    if (planIds.length > 0) {
      await sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`delete from floor_plans where id = any(${planIds}::uuid[])`;
      });
    }
    await sql.end();
  });

  async function insertPlan(sha: string | null, level?: string): Promise<string> {
    const id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`
        insert into floor_plans (id, organization_id, property_id, level, format, drawing_unit, sha256, status)
        values (${id}::uuid, ${orgId}::uuid, ${propertyId}::uuid, ${level ?? `T-${id.slice(0, 6)}`},
                'svg', 'mm', ${sha}, 'parsed')`;
    });
    planIds.push(id);
    return id;
  }

  async function insertRoom(planId: string, code: string, fields: {
    area: number; source: string; confidence?: number | null;
  }): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`
        insert into plan_rooms (organization_id, floor_plan_id, code, label, room_kind, area_sqm,
                                polygon, source, confidence)
        values (${orgId}::uuid, ${planId}::uuid, ${code}, ${code}, 'unit', ${fields.area},
                ${JSON.stringify([[0, 0], [1, 0], [1, 1]])}::jsonb, ${fields.source},
                ${fields.confidence ?? null})`;
    });
  }

  it('stores the parsed rooms and reconciles them against the stated area', async () => {
    const planId = await insertPlan('a'.repeat(64));
    const parsed = parseSvgPlan(FIXTURE, 'mm');
    expect(parsed.shapes.map((shape) => shape.code)).toEqual(['101', '102', '103']);
    expect(parsed.skipped.map((skip) => skip.reason)).toEqual(['unsupported_curve']);

    for (const shape of parsed.shapes) {
      await insertRoom(planId, shape.code, { area: shape.areaSqm, source: 'vector_geometry' });
    }

    const reconciliation = reconcileAreas(parsed.shapes, 123);
    expect(reconciliation).toMatchObject({ sumSqm: 123, verdict: 'within' });

    const stored = await sql<{ code: string; area_sqm: string; source: string; confidence: string | null }[]>`
      select code, area_sqm::text, source, confidence::text
        from plan_rooms where floor_plan_id = ${planId}::uuid order by code`;
    expect(stored.map((row) => row.code)).toEqual(['101', '102', '103']);
    expect(stored.map((row) => Number(row.area_sqm))).toEqual([60, 45, 18]);
    // Vector geometry is arithmetic: it has no confidence to report.
    expect(stored.every((row) => row.confidence === null)).toBe(true);
  });

  it('refuses a pixel-derived room without a confidence', async () => {
    const planId = await insertPlan('b'.repeat(64));
    await expect(insertRoom(planId, 'R1', { area: 40, source: 'raster_model' })).rejects.toThrow(
      /plan_rooms_confidence_ck/,
    );
    await expect(insertRoom(planId, 'R2', { area: 40, source: 'raster_model', confidence: 0.62 })).resolves.toBeUndefined();
  });

  it('refuses a confidence on a vector room, which has none', async () => {
    const planId = await insertPlan('c'.repeat(64));
    await expect(
      insertRoom(planId, 'V1', { area: 40, source: 'vector_geometry', confidence: 0.9 }),
    ).rejects.toThrow(/plan_rooms_confidence_ck/);
  });

  it('lets one drawing serve several levels while keeping one plan per level', async () => {
    await insertPlan('d'.repeat(64), 'L2');
    // Floors 2 and 3 of a building are drawn once and issued twice; refusing the
    // second upload would force somebody to duplicate the file to satisfy a schema.
    await expect(insertPlan('d'.repeat(64), 'L3')).resolves.toEqual(expect.any(String));
    // What must hold is narrower: one plan per property per level, whatever the file.
    await expect(insertPlan('f'.repeat(64), 'L2')).rejects.toThrow(/floor_plans_property_level_uq/);
  });

  it('treats a room as unconfirmed until a human names themselves', async () => {
    const planId = await insertPlan('e'.repeat(64));
    await insertRoom(planId, 'U1', { area: 55, source: 'vector_geometry' });
    const [row] = await sql<{ confirmed_by: string | null; confirmed_at: Date | null }[]>`
      select confirmed_by, confirmed_at from plan_rooms where floor_plan_id = ${planId}::uuid`;
    expect(row?.confirmed_by).toBeNull();
    expect(row?.confirmed_at).toBeNull();

    // Half a confirmation is not a confirmation.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`update plan_rooms set confirmed_at = now() where floor_plan_id = ${planId}::uuid`;
      }),
    ).rejects.toThrow(/plan_rooms_confirmed_ck/);
  });
});
