import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: '*.spec.ts', workers: 1, timeout: 180_000,
  use: { actionTimeout: 15_000, headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  outputDir: '../../../test-results/in-feed-native', reporter: [['list']] });
