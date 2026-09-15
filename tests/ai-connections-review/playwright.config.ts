import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  timeout: 30_000,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: "http://localhost:6116",
    browserName: "chromium",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "node ../../scripts/serve-storybook-static.mjs --port 6116",
    url: "http://localhost:6116/index.json",
    reuseExistingServer: true,
  },
});
