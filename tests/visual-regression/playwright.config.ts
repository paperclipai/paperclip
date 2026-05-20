import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.VISUAL_REGRESSION_PORT ?? 6210);
const STORYBOOK_STATIC = path.resolve(process.cwd(), "ui/storybook-static");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    screenshot: "off",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: `npx serve ${STORYBOOK_STATIC} -p ${PORT} --no-clipboard --single`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
