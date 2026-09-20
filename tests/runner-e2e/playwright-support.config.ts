import { defineConfig } from "@playwright/test";

/** Browser-only harness regressions: no Paperclip instance or provider credentials. */
export default defineConfig({
  testDir: ".",
  testMatch: "screenshot-readiness.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 10_000,
  use: {
    headless: true,
    ...(process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL }
      : {}),
  },
  outputDir: "./results/browser-support",
  reporter: "list",
});
