import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '@aqar/db';

/**
 * The taxonomy is only real if the database refuses the combinations the core
 * package says are impossible. These tests insert deliberately wrong rows and
 * assert Postgres says no — a CHECK for the shape, a trigger for the pairing.
 */

const databaseUrl = process.env['DATABASE_URL'];
const maybe = databaseUrl === undefined ? describe.skip : describe;

let sql: Sql;
let orgId: string;
let propertyId: string;
let buildingId: string;
const createdUnits: string[] = [];

maybe('the database enforces the space taxonomy', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('unreachable');
    sql = createSql(databaseUrl);
    const orgs = await sql<{ id: string }[]>`select id from organizations where slug = 'aqar-demo'`;
    const org = orgs[0];
    if (org === undefined) throw new Error('seeded organization missing; run pnpm db-seed');
    orgId = org.id;
    const properties = await sql<{ id: string }[]>`
      select id from properties where organization_id = ${orgId}::uuid order by created_at limit 1`;
    const property = properties[0];
    if (property === undefined) throw new Error('seeded property missing');
    propertyId = property.id;
    const buildings = await sql<{ id: string }[]>`
      select id from buildings where property_id = ${propertyId}::uuid limit 1`;
    const building = buildings[0];
    if (building === undefined) throw new Error('seeded building missing');
    buildingId = building.id;
  });

  afterAll(async () => {
    if (createdUnits.length > 0) {
      await sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`delete from units where id = any(${createdUnits}::uuid[])`;
      });
    }
    await sql.end();
  });

  async function insertUnit(fields: {
    space_kind: string;
    building_id?: string | null;
    bedrooms?: number | null;
    bathrooms?: number | null;
  }): Promise<string> {
    const id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`
        insert into units (id, organization_id, property_id, building_id, unit_number,
                           space_kind, bedrooms, bathrooms, market_rent_fils, status)
        values (${id}::uuid, ${orgId}::uuid, ${propertyId}::uuid, ${fields.building_id ?? null}::uuid,
                ${`T-${id.slice(0, 6)}`}, ${fields.space_kind}::space_kind,
                ${fields.bedrooms ?? null}, ${fields.bathrooms ?? null}, 250000, 'vacant')`;
    });
    createdUnits.push(id);
    return id;
  }

  it('refuses a flat with no building', async () => {
    await expect(
      insertUnit({ space_kind: 'flat', building_id: null, bedrooms: 2, bathrooms: 1 }),
    ).rejects.toThrow(/units_building_ck/);
  });

  it('refuses land that claims a building', async () => {
    await expect(
      insertUnit({ space_kind: 'land', building_id: buildingId }),
    ).rejects.toThrow(/units_building_ck/);
  });

  it('refuses a flat with no bedroom count, and a warehouse with one', async () => {
    await expect(
      insertUnit({ space_kind: 'flat', building_id: buildingId, bedrooms: null, bathrooms: null }),
    ).rejects.toThrow(/units_residential_counts_ck/);
    await expect(
      insertUnit({ space_kind: 'warehouse', building_id: buildingId, bedrooms: 3, bathrooms: 2 }),
    ).rejects.toThrow(/units_nonresidential_counts_ck/);
  });

  it('accepts a plot of land and a warehouse, and gives each its own attributes', async () => {
    const landId = await insertUnit({ space_kind: 'land' });
    const warehouseId = await insertUnit({ space_kind: 'warehouse', building_id: buildingId });

    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into unit_land_detail (unit_id, plot_number, plot_area_sqm, max_far)
               values (${landId}::uuid, 'PLOT-91', 820.5, 1.8)`;
      await tx`insert into unit_industrial_detail (unit_id, clear_height_m, dock_doors, three_phase_power)
               values (${warehouseId}::uuid, 8.2, 2, true)`;
    });

    const rows = await sql<{ kind: string; area: string | null; height: string | null }[]>`
      select u.space_kind::text as kind, l.plot_area_sqm::text as area, i.clear_height_m::text as height
        from units u
        left join unit_land_detail l on l.unit_id = u.id
        left join unit_industrial_detail i on i.unit_id = u.id
       where u.id in (${landId}::uuid, ${warehouseId}::uuid)
       order by kind`;
    expect(rows).toEqual([
      { kind: 'land', area: '820.5', height: null },
      { kind: 'warehouse', area: null, height: '8.2' },
    ]);
  });

  it('refuses shop attributes on a flat — the pairing is a trigger, not a convention', async () => {
    const flatId = await insertUnit({ space_kind: 'flat', building_id: buildingId, bedrooms: 2, bathrooms: 1 });
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into unit_commercial_detail (unit_id, frontage_m, display_windows)
                 values (${flatId}::uuid, 6.5, 2)`;
      }),
    ).rejects.toThrow(/cannot have unit_commercial_detail detail/);
  });

  it('refuses an agricultural lease billed monthly', async () => {
    const units = await sql<{ id: string }[]>`
      select id from units where organization_id = ${orgId}::uuid and building_id is not null limit 1`;
    const unit = units[0];
    if (unit === undefined) throw new Error('no unit');
    const leaseId = randomUUID();
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`
          insert into leases (id, organization_id, property_id, unit_id, status, start_date, end_date,
                              rent_fils, deposit_fils, due_day, lease_kind, billing_cycle)
          values (${leaseId}::uuid, ${orgId}::uuid, ${propertyId}::uuid, ${unit.id}::uuid, 'upcoming',
                  '2027-01-01', '2027-12-31', 1000000, 1000000, 1, 'agricultural', 'monthly')`;
      }),
    ).rejects.toThrow(/leases_cycle_ck/);
  });
});
