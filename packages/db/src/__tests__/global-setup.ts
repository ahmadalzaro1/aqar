import { existsSync } from 'node:fs';
import postgres from 'postgres';

/**
 * The integration suite is destructive (it drops `public`/`app` and replays the
 * migrations), so this setup does two things before any test runs:
 *   1. resolves the test URL the same way `vitest.config.ts` does — vitest's
 *      `test.env` is NOT visible inside `globalSetup`, so it must be re-derived
 *      here rather than read from the injected `DATABASE_URL`;
 *   2. creates that database if the server does not have it yet — a fresh
 *      Docker volume or a clean CI runner needs no manual `CREATE DATABASE`.
 *
 * Any target whose name does not end in `_test` is refused outright.
 */
function resolveTestUrl(): string {
  const envPath = new URL('../../../.env', import.meta.url).pathname;
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const explicit = process.env['AQAR_TEST_DATABASE_URL'];
  if (explicit !== undefined) return explicit;

  const base = process.env['DATABASE_URL'] ?? 'postgres://aqar:aqar@127.0.0.1:5433/aqar';
  const url = new URL(base);
  url.pathname = '/aqar_test';
  return url.toString();
}

export default async function setup(): Promise<void> {
  const testUrl = resolveTestUrl();
  const dbName = new URL(testUrl).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `refusing to run the destructive integration suite against "${dbName}" — it must end in _test`,
    );
  }

  const admin = new URL(testUrl);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(`create database "${dbName}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
