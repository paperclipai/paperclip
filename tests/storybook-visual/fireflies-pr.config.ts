import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "fireflies-pr.spec.ts",
  workers: 1,
  timeout: 180_000,
  retries: 0,
  outputDir: "./test-results/fireflies-pr",
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:6149", viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", trace: "retain-on-failure" },
  webServer: { command: "node ../../scripts/serve-storybook-static.mjs --port 6149", url: "http://127.0.0.1:6149/index.json", reuseExistingServer: false },
});
