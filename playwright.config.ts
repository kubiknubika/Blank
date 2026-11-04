import { defineConfig } from '@playwright/test';

/**
 * E2E runs against the REAL production artifact: `npm run build`, then the
 * Express server serving the built SPA and API from one origin — the same
 * code path as the Docker image. NODE_ENV=production also exercises the
 * strict security checks (no dev loopback exemptions).
 *
 * The suite is deliberately serial (workers: 1): it shares one SQLite
 * file, and determinism beats a few seconds of wall time here.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run build && npm start',
    url: 'http://127.0.0.1:3100/api/ready',
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: 'production',
      PORT: '3100',
      HOST: '127.0.0.1',
      DB_PATH: 'server/data/e2e.db',
      SEED_ON_EMPTY: 'true',
      LOG_LEVEL: 'warn',
    },
  },
});
