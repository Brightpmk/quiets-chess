import { defineConfig } from '@playwright/test';
const externalServer = process.env.QUIET_CHESS_TEST_URL;
export default defineConfig({
  testDir: './tests/e2e', timeout: 30_000, fullyParallel: false, workers: 1,
  use: {baseURL: externalServer ?? 'http://127.0.0.1:5173', headless: true, trace: 'retain-on-failure'},
  webServer: externalServer ? undefined : {command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI},
});
