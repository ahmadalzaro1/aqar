import { defineConfig } from 'vitest/config';

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
      DATABASE_URL: 'postgres://aqar:aqar_dev@127.0.0.1:5433/aqar_test',
    },
  },
});
