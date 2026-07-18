import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const testDir = dirname(fileURLToPath(import.meta.url));
const snapshotDir = process.env.STORYBOOK_VISUAL_SNAPSHOT_DIR
  ? isAbsolute(process.env.STORYBOOK_VISUAL_SNAPSHOT_DIR)
    ? process.env.STORYBOOK_VISUAL_SNAPSHOT_DIR
    : resolve(testDir, "..", "..", process.env.STORYBOOK_VISUAL_SNAPSHOT_DIR)
  : join(testDir, ".snapshots");

// Visual snapshot suite for the design-token extraction run: screenshots every
// built Storybook story in both themes and compares against the external Phase
// 0 baseline downloaded by scripts/storybook-visual-baseline.mjs.
export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  timeout: 60_000,
  retries: 1,
  workers: 4,
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixels: 0,
    },
  },
  snapshotPathTemplate: `${snapshotDir}/{arg}{ext}`,
  use: {
    browserName: "chromium",
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 1,
    // JS-driven tickers/timers key off prefers-reduced-motion for
    // deterministic captures (CSS animations are already disabled).
    reducedMotion: "reduce",
    baseURL: "http://localhost:6106",
  },
  webServer: {
    command: "node ../../scripts/serve-storybook-static.mjs --port 6106",
    url: "http://localhost:6106/index.json",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
