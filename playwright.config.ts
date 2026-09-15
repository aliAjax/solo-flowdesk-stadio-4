import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: [
    {
      command: 'node server/server.mjs',
      url: 'http://127.0.0.1:4180/api/state',
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: '4180',
        ALLOW_RESET: '1',
        TICKET_DB: '/tmp/ticket-test-db.json',
        TICKET_LOCK_TTL_MS: '4000',
        TICKET_PAY_TTL_MS: '8000',
      },
    },
    {
      command: 'npm run dev -- --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
