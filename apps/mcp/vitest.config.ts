import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    // The integration test talks to the live Postgres/Redis; never interleave.
    fileParallelism: false,
  },
});
