import { defineConfig } from '@playwright/test';
import { env } from './src/core/util/env.js';

export default defineConfig({
  testDir: './tests',
  // Managed regions let generated and handwritten tests share one file; do not
  // let Playwright treat .txt scenario files as specs.
  testMatch: /.*\.spec\.ts/,

  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  use: {
    baseURL: env.BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/run-report/test-results.json' }],
    ['html', { open: 'never' }],
  ],

  outputDir: 'artifacts/playwright',
});
