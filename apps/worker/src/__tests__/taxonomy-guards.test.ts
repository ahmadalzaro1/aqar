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
const createdBuildings: string[] = [];

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
    if (createdBuildings.length > 0) {
      await sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`delete from buildings where id = any(${createdBuildings}::uuid[])`;
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
    await expect(insertUnit({ space_kind: 'land', building_id: buildingId })).rejects.toThrow(
      /units_building_ck/,
    );
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
    const flatId = await insertUnit({
      space_kind: 'flat',
      building_id: buildingId,
      bedrooms: 2,
      bathrooms: 1,
    });
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into unit_commercial_detail (unit_id, frontage_m, display_windows)
                 values (${flatId}::uuid, 6.5, 2)`;
      }),
    ).rejects.toThrow(/cannot have unit_commercial_detail detail/);
  });

  it('lets a rooftop have a building, and refuses one without', async () => {
    // A roof belongs to a building. 0008 forbade the link, which left no honest
    // value for a roof that belongs to nothing.
    await expect(insertUnit({ space_kind: 'rooftop', building_id: null })).rejects.toThrow(
      /units_building_ck/,
    );
    const roofId = await insertUnit({ space_kind: 'rooftop', building_id: buildingId });
    const parksId = await insertUnit({ space_kind: 'parking', building_id: null });
    const signId = await insertUnit({ space_kind: 'signage', building_id: buildingId });
    expect([roofId, parksId, signId].every((id) => id.length > 0)).toBe(true);
  });

  it('keeps parking attributes on a bay, not on a plot', async () => {
    const landId = await insertUnit({ space_kind: 'land' });
    const bayId = await insertUnit({ space_kind: 'parking', building_id: null });

    // The pairing guard: a plot cannot acquire a bay width, a bay cannot acquire a FAR.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into unit_parking_detail (unit_id, bay_width_m)
                 values (${landId}::uuid, 2.4)`;
      }),
    ).rejects.toThrow(/cannot have unit_parking_detail detail/);

    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into unit_land_detail (unit_id, max_far) values (${bayId}::uuid, 1.8)`;
      }),
    ).rejects.toThrow(/cannot have unit_land_detail detail/);

    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into unit_parking_detail
                 (unit_id, level, bay_width_m, bay_length_m, clearance_m, is_covered, has_ev_charger)
               values (${bayId}::uuid, 'B1', 2.4, 5.0, 2.05, true, true)`;
    });

    const rows = await sql<{ width: string; clearance: string }[]>`
      select bay_width_m::text as width, clearance_m::text as clearance
        from unit_parking_detail where unit_id = ${bayId}::uuid`;
    expect(rows[0]).toEqual({ width: '2.4', clearance: '2.05' });
  });

  it('refuses a bay that is both allocated and separately deeded', async () => {
    const bayId = await insertUnit({ space_kind: 'parking', building_id: null });
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into unit_parking_detail (unit_id, is_allocated, has_own_deed)
                 values (${bayId}::uuid, true, true)`;
      }),
    ).rejects.toThrow(/unit_parking_deed_ck/);
  });

  it('ties a bay to the flat it serves, and refuses a link across properties', async () => {
    const flatId = await insertUnit({
      space_kind: 'flat',
      building_id: buildingId,
      bedrooms: 2,
      bathrooms: 1,
    });
    const bayId = await insertUnit({ space_kind: 'parking', building_id: null });

    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into unit_parking_detail (unit_id, allocated_to_unit_id)
               values (${bayId}::uuid, ${flatId}::uuid)`;
    });
    const linked = await sql<{ allocated_to_unit_id: string }[]>`
      select allocated_to_unit_id from unit_parking_detail where unit_id = ${bayId}::uuid`;
    expect(linked[0]?.allocated_to_unit_id).toBe(flatId);

    // A bay belonging to a flat on another property is a billing dispute waiting
    // to happen, so the trigger refuses it. Pick the target by the boundary the
    // trigger actually checks: this bay has no building, so `bay_building is not
    // null` skips the building guard and the property guard is the only refusal
    // reachable. `order by id` used to pick whichever row carried the lowest
    // random UUID, and a unit on the *same* property is a legal allocation, so
    // half the seeds passed for the wrong reason.
    const others = await sql<{ id: string }[]>`
      select id from units
       where organization_id = ${orgId}::uuid
         and property_id <> ${propertyId}::uuid
       limit 1`;
    const other = others[0];
    if (other === undefined)
      throw new Error('need a unit on another property; the seed must create one');
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`update unit_parking_detail set allocated_to_unit_id = ${other.id}::uuid
                  where unit_id = ${bayId}::uuid`;
      }),
    ).rejects.toThrow(/different properties/);

    // A bay cannot be allocated to another bay.
    const secondBay = await insertUnit({ space_kind: 'parking', building_id: null });
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into unit_parking_detail (unit_id, allocated_to_unit_id)
                 values (${secondBay}::uuid, ${bayId}::uuid)`;
      }),
    ).rejects.toThrow(/cannot be allocated to another parking bay/);
  });

  it('refuses a link across buildings inside one property', async () => {
    // The building guard only fires when the bay carries a building, and the
    // seed gives each property exactly one — so this case creates the second
    // building itself rather than borrowing one from another property.
    const annexId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into buildings (id, organization_id, property_id, name, name_ar)
               values (${annexId}::uuid, ${orgId}::uuid, ${propertyId}::uuid, 'Annex', 'ملحق')`;
    });
    createdBuildings.push(annexId);

    const flatId = await insertUnit({
      space_kind: 'flat',
      building_id: buildingId,
      bedrooms: 2,
      bathrooms: 1,
    });
    const bayId = await insertUnit({ space_kind: 'parking', building_id: buildingId });
    const acrossTheYard = await insertUnit({
      space_kind: 'flat',
      building_id: annexId,
      bedrooms: 1,
      bathrooms: 1,
    });

    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into unit_parking_detail (unit_id, allocated_to_unit_id)
                 values (${bayId}::uuid, ${acrossTheYard}::uuid)`;
      }),
    ).rejects.toThrow(/different buildings/);

    // Same property, same building: the link this bay exists for.
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into unit_parking_detail (unit_id, allocated_to_unit_id)
               values (${bayId}::uuid, ${flatId}::uuid)`;
    });
  });

  it('treats the same number on two levels as two bays, and the same level as one', async () => {
    const number = `L${Math.floor(Math.random() * 100000)}`;
    const onLevelOne = randomUUID();
    const onLevelTwo = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into units (id, organization_id, property_id, building_id, unit_number, floor,
                                 space_kind, bedrooms, bathrooms, market_rent_fils, status)
               values (${onLevelOne}::uuid, ${orgId}::uuid, ${propertyId}::uuid, ${buildingId}::uuid,
                       ${number}, '1', 'flat', 2, 1, 250000, 'vacant')`;
      await tx`insert into units (id, organization_id, property_id, building_id, unit_number, floor,
                                 space_kind, bedrooms, bathrooms, market_rent_fils, status)
               values (${onLevelTwo}::uuid, ${orgId}::uuid, ${propertyId}::uuid, ${buildingId}::uuid,
                       ${number}, '2', 'flat', 2, 1, 250000, 'vacant')`;
    });
    createdUnits.push(onLevelOne, onLevelTwo);

    // Same number, same level: refused.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into units (id, organization_id, property_id, building_id, unit_number, floor,
                                   space_kind, bedrooms, bathrooms, market_rent_fils, status)
                 values (${randomUUID()}::uuid, ${orgId}::uuid, ${propertyId}::uuid, ${buildingId}::uuid,
                         ${number}, '1', 'flat', 2, 1, 250000, 'vacant')`;
      }),
    ).rejects.toThrow(/units_building_floor_number_uq/);
  });

  it('identifies buildingless units per property, not by a NULL building', async () => {
    const plot = `P${Math.floor(Math.random() * 100000)}`;
    const firstId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into units (id, organization_id, property_id, building_id, unit_number,
                                 space_kind, market_rent_fils, status)
               values (${firstId}::uuid, ${orgId}::uuid, ${propertyId}::uuid, null,
                       ${plot}, 'land', 0, 'vacant')`;
    });
    createdUnits.push(firstId);

    // Two NULL buildings never collide in a plain unique index, so the parcel index
    // has to be partial and explicit.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`insert into units (id, organization_id, property_id, building_id, unit_number,
                                   space_kind, market_rent_fils, status)
                 values (${randomUUID()}::uuid, ${orgId}::uuid, ${propertyId}::uuid, null,
                         ${plot}, 'land', 0, 'vacant')`;
      }),
    ).rejects.toThrow(/units_property_number_uq/);
  });

  it('keeps the apartment legal block honest', async () => {
    const flatId = await insertUnit({
      space_kind: 'flat',
      building_id: buildingId,
      bedrooms: 2,
      bathrooms: 2,
    });
    // net area cannot exceed gross
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`update units set area_sqm = 120, net_area_sqm = 130 where id = ${flatId}::uuid`;
      }),
    ).rejects.toThrow(/units_net_le_gross_ck/);
    // a share of the common areas belongs to a building
    const landId = await insertUnit({ space_kind: 'land' });
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`update units set common_share_permille = 50 where id = ${landId}::uuid`;
      }),
    ).rejects.toThrow(/units_common_share_needs_building_ck/);
    // and cannot exceed the whole building
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`update units set common_share_permille = 1001 where id = ${flatId}::uuid`;
      }),
    ).rejects.toThrow(/units_common_share_ck/);

    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`update units set area_sqm = 120, net_area_sqm = 104,
                   common_share_permille = 125, occupancy_permit_ref = 'AMM-OCC-1'
                where id = ${flatId}::uuid`;
    });
    const rows = await sql<{ net: string; share: number; permit: string }[]>`
      select net_area_sqm::text as net, common_share_permille as share, occupancy_permit_ref as permit
        from units where id = ${flatId}::uuid`;
    expect(rows[0]).toEqual({ net: '104', share: 125, permit: 'AMM-OCC-1' });
  });

  it('separates licensed use from permitted use on commercial space', async () => {
    const shopId = await insertUnit({ space_kind: 'shop', building_id: buildingId });
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into unit_commercial_detail
                 (unit_id, frontage_m, display_windows, permitted_use, licensed_use,
                  power_capacity_kva, has_fire_system)
               values (${shopId}::uuid, 6, 2, 'retail', 'restaurant', 45, true)`;
    });
    const rows = await sql<{ permitted: string; licensed: string; kva: string }[]>`
      select permitted_use as permitted, licensed_use as licensed, power_capacity_kva::text as kva
        from unit_commercial_detail where unit_id = ${shopId}::uuid`;
    expect(rows[0]).toEqual({ permitted: 'retail', licensed: 'restaurant', kva: '45' });

    // Zero kVA is not a capacity.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`update unit_commercial_detail set power_capacity_kva = 0
                  where unit_id = ${shopId}::uuid`;
      }),
    ).rejects.toThrow(/unit_commercial_power_ck/);
  });

  it('gives signage a face, an orientation and a permit', async () => {
    const signId = await insertUnit({ space_kind: 'signage', building_id: buildingId });
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into unit_signage_detail (unit_id, face_area_sqm, orientation, permit_ref, is_illuminated)
               values (${signId}::uuid, 12.5, 'north_east', 'AMM-SGN-1', true)`;
    });
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`update unit_signage_detail set orientation = 'sideways'
                  where unit_id = ${signId}::uuid`;
      }),
    ).rejects.toThrow(/unit_signage_orientation_ck/);
  });

  it('keeps the DLS legal block on the plot', async () => {
    const landId = await insertUnit({ space_kind: 'land' });
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into unit_land_detail
                 (unit_id, plot_number, basin, zoning_permit_ref, max_far,
                  setback_front_m, setback_side_m, setback_rear_m, road_width_m, has_lien)
               values (${landId}::uuid, '447', 'حوض الويبدة 12', 'AMM-ZN-1', 1.6, 4, 2.5, 3, 8, true)`;
    });
    const rows = await sql<{ basin: string; lien: boolean; road: string }[]>`
      select basin, has_lien as lien, road_width_m::text as road
        from unit_land_detail where unit_id = ${landId}::uuid`;
    expect(rows[0]).toEqual({ basin: 'حوض الويبدة 12', lien: true, road: '8' });

    // A negative setback is not a setback.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`update unit_land_detail set setback_front_m = -1 where unit_id = ${landId}::uuid`;
      }),
    ).rejects.toThrow(/unit_land_setbacks_ck/);
  });

  it('lets a flat be deleted while a bay is allocated to it', async () => {
    // Regression: the FK is ON DELETE SET NULL, which re-enters the detail guard
    // after the bay's own unit row is already gone. Before the fix, deleting any
    // flat with an allocated bay failed outright — nobody could remove a tenant's
    // flat from the system.
    const flatId = await insertUnit({
      space_kind: 'flat',
      building_id: buildingId,
      bedrooms: 1,
      bathrooms: 1,
    });
    const bayId = await insertUnit({ space_kind: 'parking', building_id: null });
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`insert into unit_parking_detail (unit_id, allocated_to_unit_id, bay_width_m)
               values (${bayId}::uuid, ${flatId}::uuid, 2.4)`;
    });

    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`delete from units where id = ${flatId}::uuid`;
    });

    const bays = await sql<{ allocated_to_unit_id: string | null; width: string }[]>`
      select allocated_to_unit_id, bay_width_m::text as width
        from unit_parking_detail where unit_id = ${bayId}::uuid`;
    expect(bays[0]).toEqual({ allocated_to_unit_id: null, width: '2.4' });
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
