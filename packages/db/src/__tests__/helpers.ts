import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { migrateUp } from '../migrate.js';

export const TEST_URL = process.env.DATABASE_URL ?? 'postgres://aqar:aqar@127.0.0.1:5433/aqar_test';
// Build the RLS-enforced role URL by parsing, never string replacement:
// the test URL's password may come from env/.env and must not matter here.
const appUrl = new URL(TEST_URL);
appUrl.username = 'aqar_app';
appUrl.password = 'aqar_app_dev';
export const APP_URL = appUrl.toString();

/** Drop both schemas and replay the migrations from scratch. */
export async function resetSchema(): Promise<void> {
  const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA public;',
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  await migrateUp(TEST_URL);
}

export type Fixture = {
  readonly orgId: string;
  readonly propertyId: string;
  readonly unitId: string;
  readonly tenantId: string;
  readonly leaseId: string;
};

/** Minimal tenant-shaped fixture (organization -> property -> building -> unit -> tenant -> lease). */
export async function createFixture(sql: postgres.Sql, tag: string): Promise<Fixture> {
  const orgId = randomUUID();
  const propertyId = randomUUID();
  const buildingId = randomUUID();
  const unitId = randomUUID();
  const tenantId = randomUUID();
  const leaseId = randomUUID();

  await sql`insert into organizations (id, name, name_ar, slug, timezone, currency)
            values (${orgId}, ${'Fixture ' + tag}, ${'مؤسسة ' + tag}, ${'fixture-' + tag}, 'Asia/Amman', 'JOD')`;
  await sql`insert into properties (id, organization_id, name, name_ar, district, city)
            values (${propertyId}, ${orgId}, ${'Prop ' + tag}, ${'عقار ' + tag}, 'Abdoun', 'Amman')`;
  await sql`insert into buildings (id, organization_id, property_id, name, name_ar)
            values (${buildingId}, ${orgId}, ${propertyId}, ${'Bld ' + tag}, ${'بناية ' + tag})`;
  // space_kind defaults to 'flat', and a flat must now state its room count: the
  // residential CHECK refuses a flat with an unknown number of bedrooms. A fixture
  // that leaves it out is describing a flat nobody can let.
  await sql`insert into units (id, organization_id, property_id, building_id, unit_number,
                               bedrooms, bathrooms, market_rent_fils, status)
            values (${unitId}, ${orgId}, ${propertyId}, ${buildingId}, ${'U-' + tag},
                    2, 1, 400000, 'occupied')`;
  await sql`insert into tenants (id, organization_id, full_name_en, full_name_ar, phone)
            values (${tenantId}, ${orgId}, ${'Tenant ' + tag}, ${'مستأجر ' + tag}, '+962790000000')`;
  await sql`insert into leases (id, organization_id, property_id, unit_id, status, start_date, end_date, rent_fils, deposit_fils, due_day)
            values (${leaseId}, ${orgId}, ${propertyId}, ${unitId}, 'active', '2025-01-01', '2027-12-31', 400000, 400000, 1)`;
  return { orgId, propertyId, unitId, tenantId, leaseId };
}
