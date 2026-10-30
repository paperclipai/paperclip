import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'in-feed-connections.spec.ts', workers: 4,
  timeout: 30_000, retries: 0, outputDir: './test-results/in-feed', reporter: [['list']],
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:6126', reducedMotion: 'reduce' },
  webServer: { command: 'node ../../scripts/serve-storybook-static.mjs --port 6126', url: 'http://127.0.0.1:6126/index.json', reuseExistingServer: false } });
