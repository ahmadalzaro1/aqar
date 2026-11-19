import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { migrateDown, migrateUp } from '../migrate.js';

export const TEST_URL =
  process.env.DATABASE_URL ?? 'postgres://aqar:aqar_dev@127.0.0.1:5433/aqar_test';
export const APP_URL = TEST_URL.replace('aqar:aqar_dev@', 'aqar_app:aqar_app_dev@');

/**
 * LANDING BUG B1 (drizzle/0002_guards.sql) — app.assert_period_open() does
 * `target_period := NEW.period;` before the payments branch, so EVERY insert into
 * `payments` fails with: record "new" has no field "period".
 *
 * This suite must not silently weaken the guard, so it re-applies the same
 * function with the branch reordered: the guard behaviour for charges and
 * payments is unchanged (both are still rejected in locked periods, which the
 * period-lock test asserts for both tables). Delete this once the migration is
 * fixed upstream.
 */
export const PERIOD_GUARD_FIX = `
CREATE OR REPLACE FUNCTION app.assert_period_open() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_period text;
BEGIN
  IF tg_table_name = 'payments' THEN
    target_period := coalesce(NEW.reference_period, to_char(NEW.received_date, 'YYYY-MM'));
  ELSE
    target_period := NEW.period;
  END IF;

  IF target_period IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM period_locks pl
     WHERE pl.organization_id = NEW.organization_id
       AND pl.period = target_period
  ) THEN
    RAISE EXCEPTION
      'period % is locked for organization %; no writes are accepted',
      target_period, NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
`;

export async function applyPeriodGuardFix(): Promise<void> {
  const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(PERIOD_GUARD_FIX);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Drop both schemas, replay migrations, re-apply the guard fix. */
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
  await applyPeriodGuardFix();
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
  await sql`insert into units (id, organization_id, property_id, building_id, unit_number, market_rent_fils, status)
            values (${unitId}, ${orgId}, ${propertyId}, ${buildingId}, ${'U-' + tag}, 400000, 'occupied')`;
  await sql`insert into tenants (id, organization_id, full_name_en, full_name_ar, phone)
            values (${tenantId}, ${orgId}, ${'Tenant ' + tag}, ${'مستأجر ' + tag}, '+962790000000')`;
  await sql`insert into leases (id, organization_id, property_id, unit_id, status, start_date, end_date, rent_fils, deposit_fils, due_day)
            values (${leaseId}, ${orgId}, ${propertyId}, ${unitId}, 'active', '2025-01-01', '2027-12-31', 400000, 400000, 1)`;
  return { orgId, propertyId, unitId, tenantId, leaseId };
}
