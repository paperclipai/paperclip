import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'repository-skill-packages.spec.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  outputDir: './repository-skill-results',
  reporter: 'list',
  use: {
    baseURL: process.env.PAPERCLIP_REPOSITORY_STORYBOOK_URL ?? 'http://localhost:6106',
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  },
});
