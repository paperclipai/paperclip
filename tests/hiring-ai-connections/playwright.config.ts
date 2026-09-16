import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "test-results",
  workers: 1,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: { actionTimeout: 30_000, navigationTimeout: 30_000,
    baseURL: process.env.HIRING_AI_TEST_URL ?? "http://127.0.0.1:3101",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
