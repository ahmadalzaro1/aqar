import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end, accessibility and performance harness.
 *
 * Runs against a real Next.js server and the real Postgres/Redis stack — no
 * mocked endpoints. `E2E_BASE_URL` points at an existing server; otherwise
 * Playwright boots `next dev` and waits for /login.
 *
 * The bank and statement specs write to the database, so the suite is serial
 * (workers: 1) and the statement spec targets a period/property that has no
 * statement yet.
 */
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-report.json' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile-390', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer:
    process.env['E2E_BASE_URL'] === undefined
      ? {
          command: 'pnpm dev',
          url: `${baseURL}/login`,
          reuseExistingServer: true,
          timeout: 180_000,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      : undefined,
});
