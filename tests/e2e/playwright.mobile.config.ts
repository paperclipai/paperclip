import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3100);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * Mobile E2E config — runs tests against Pixel 5 (393x851) viewport.
 * Validates layout, pointer events, and interaction correctness in Mobile Chrome.
 *
 * Usage:
 *   pnpm exec playwright test --config tests/e2e/playwright.mobile.config.ts
 *
 * To target a remote server instead of local:
 *   PLAYWRIGHT_BASE_URL=http://your-server pnpm exec playwright test --config tests/e2e/playwright.mobile.config.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.mobile.spec.ts",
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "Mobile Chrome (Pixel 5)",
      use: {
        ...devices["Pixel 5"],
        browserName: "chromium",
      },
    },
  ],
  webServer: {
    command: `pnpm paperclipai run --yes`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: "./test-results-mobile",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report-mobile" }]],
});
