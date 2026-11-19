import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Derive the test URL from the repo's real .env at config time — never
// commit a credential. Falls back to the public .env.example fixture.
const envPath = new URL('../../.env', import.meta.url).pathname;
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base =
  process.env['AQAR_TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://aqar:***@127.0.0.1:5433/aqar';
const testUrl = base.replace(/\/[^/]+$/, '/aqar_test');

/**
 * Integration tests run against a REAL PostgreSQL 16 instance (no sqlite, no DB
 * mocks). They need `aqar_test` to exist; the suite resets `public`/`app` and
 * replays the migrations in `beforeAll`.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
    env: {
      DATABASE_URL: testUrl,
    },
  },
});
