import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results',
  use: { baseURL: 'http://127.0.0.1:3107' },
  webServer: {
    command: 'node --experimental-strip-types smoke/serve.ts',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://127.0.0.1:3107/api/health',
    timeout: 240_000,
    reuseExistingServer: false,
    // serve.ts stops the feed, Next and the container on SIGTERM; Playwright's
    // default is SIGKILL, which would skip that and orphan the container.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
