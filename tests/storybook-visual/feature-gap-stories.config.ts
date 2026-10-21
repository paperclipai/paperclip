import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: ["feature-gap-stories.spec.ts", "map-navigation.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  fullyParallel: true,
  workers: 4,
  reporter: "list",
  outputDir: "./test-results/feature-gaps",
  use: {
    baseURL: process.env.PAPERCLIP_GAP_STORYBOOK_URL ?? "http://localhost:6136",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  },
});
