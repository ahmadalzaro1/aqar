import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The live e2e talks to one Postgres/Redis/model; never interleave files.
    fileParallelism: false,
  },
});
