import { defineConfig } from "@playwright/test";

const BASE_URL =
  process.env.PAPERCLIP_RELEASE_SMOKE_BASE_URL ?? "http://127.0.0.1:3232";

// Opt-in: roteia o Chromium pelo proxy do br-proxy quando definido.
// Ex.: PLAYWRIGHT_PROXY_SERVER="http://10.100.0.1:8888" pnpm test:release-smoke
const PROXY_SERVER = process.env.PLAYWRIGHT_PROXY_SERVER;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(PROXY_SERVER ? { proxy: { server: PROXY_SERVER, bypass: "localhost,127.0.0.1" } } : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
