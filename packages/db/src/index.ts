// @aqar/db — Drizzle schema, migrations and seed for the Aqar property OS.
// Apps import table definitions and the connection helpers from here.
export * from './schema/index.js';
export {
  createDb,
  createSql,
  databaseUrl,
  withOrganization,
  DEFAULT_DATABASE_URL,
} from './client.js';
export type { Db, Sql } from './client.js';
