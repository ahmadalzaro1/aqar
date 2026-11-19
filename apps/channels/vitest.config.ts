import { defineConfig } from 'vitest/config';

/**
 * These suites exercise real code paths against the live dev stack:
 * PostgreSQL :5433, Redis :6380 and Mailpit SMTP :1025 / HTTP :8025.
 * Nothing is mocked — see src/__tests__/*.integration.test.ts.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
