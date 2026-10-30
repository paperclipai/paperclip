import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testIgnore: process.env.AI_REPAIR_TEST_ALLOW_DESTRUCTIVE === "1" ? [] : ["**/*.live.spec.ts"],
  outputDir: "./test-results",
  timeout: 45_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.AI_CONNECTIONS_TEST_URL ?? "http://127.0.0.1:3100",
    browserName: "chromium",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
});
