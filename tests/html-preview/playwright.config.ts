import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:6189", viewport: { width: 1200, height: 900 } },
  webServer: {
    command: "node ui/node_modules/storybook/dist/bin/dispatcher.js dev -p 6189 --host 127.0.0.1 --exact-port -c ui/storybook/.storybook --ci",
    cwd: "../..",
    url: "http://127.0.0.1:6189/index.json",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
