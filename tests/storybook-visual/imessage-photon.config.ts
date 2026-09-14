import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "imessage-photon.spec.ts", workers: 2,
  timeout: 30_000, retries: 0, outputDir: "./test-results/imessage-photon",
  reporter: [["list"]],
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:6128", reducedMotion: "reduce" },
  webServer: {
    command: "node ../../scripts/serve-storybook-static.mjs --port 6128",
    url: "http://127.0.0.1:6128/index.json", reuseExistingServer: false,
  },
});
