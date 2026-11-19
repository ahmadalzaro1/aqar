import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * Connection factory.
 *
 * Two roles exist in dev:
 *  - `aqar`      (superuser) — migrations, seed, test fixtures only
 *  - `aqar_app`  (LOGIN, NOSUPERUSER, NOBYPASSRLS) — the only role the apps use;
 *                it is subject to row level security on every tenant-scoped table.
 *
 * Apps MUST run every tenant query through `withOrganization` (or set the GUC
 * themselves on the same connection) or RLS returns zero rows / rejects writes.
 */
export type Sql = ReturnType<typeof postgres>;
export type Db = ReturnType<typeof createDb>['db'];

export const DEFAULT_DATABASE_URL = 'postgres://aqar:aqar@127.0.0.1:5433/aqar';

export function databaseUrl(): string {
  return process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
}

export function createSql(url: string = databaseUrl(), max = 10): Sql {
  return postgres(url, {
    max,
    // timestamptz comes back as JS Date; ids stay strings.
    onnotice: () => undefined,
  });
}

export function createDb(url: string = databaseUrl(), max = 10) {
  const client = createSql(url, max);
  const db = drizzle(client, { schema });
  return { client, db };
}

/**
 * Runs `fn` inside a transaction whose `app.organization_id` GUC is set for its
 * duration (`set_config(..., true)` = transaction-local, so pooled connections
 * never leak a tenant scope).
 */
export async function withOrganization<T>(
  db: Db,
  organizationId: string,
  fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

export { schema };
