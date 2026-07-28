import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..");

export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    baseURL: "http://127.0.0.1:6173",
  },
  webServer: {
    command: "node scripts/serve-deck-product-flow-static.mjs --port 6173",
    cwd: repoRoot,
    url: "http://127.0.0.1:6173/deck-product-flow.html",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
