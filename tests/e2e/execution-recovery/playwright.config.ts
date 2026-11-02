import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 300_000,
  use: {
    viewport: { width: 1440, height: 1080 },
    actionTimeout: 15_000,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "../../../test-results/execution-recovery",
  reporter: [["list"]],
});
