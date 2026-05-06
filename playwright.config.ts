import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PAPERCLIP_VISUAL_REGRESS_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./scripts",
  testMatch: "visual-regress.spec.ts",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "chromium-tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 } },
    },
  ],
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
    },
  },
  outputDir: "./scripts/visual-regress-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./scripts/visual-regress-report" }]],
});
