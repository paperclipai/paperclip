import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "remote-mcp-connections.spec.ts", workers: 1, fullyParallel: false,
  timeout: 180_000, retries: 0, outputDir: "./test-results/remote-mcp", reporter: [["list"]],
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:6138", reducedMotion: "reduce", actionTimeout: 10_000, trace: "retain-on-failure" },
  webServer: { command: "node ../../scripts/serve-storybook-static.mjs --port 6138", url: "http://127.0.0.1:6138/index.json", reuseExistingServer: false },
});
