import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "company-context-refresh.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: {
    headless: true,
    ...(process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL }
      : {}),
  },
  outputDir: "./test-results",
  reporter: "list",
});
