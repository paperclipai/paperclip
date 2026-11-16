import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../e2e", testMatch: "runner-e2e-dashboard.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, outputDir: "../../test-results/eval-report-navigation",
  use: { browserName: "chromium", headless: true }, reporter: "list",
});
