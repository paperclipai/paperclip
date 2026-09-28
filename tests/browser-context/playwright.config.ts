import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: { headless: true },
  outputDir: "./test-results",
  reporter: "list",
});
