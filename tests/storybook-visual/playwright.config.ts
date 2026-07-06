import { defineConfig } from "@playwright/test";

// Visual snapshot suite for the design-token extraction run: screenshots every
// built Storybook story in both themes and compares against the committed
// Phase 0 baseline. Run via `pnpm test:storybook-visual` (builds Storybook
// first) or `SKIP_SB_BUILD=1` + `npx playwright test -c tests/storybook-visual`
// against an existing ui/storybook-static build.
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
      // Same machine, same browser build: require byte-identical rendering.
      maxDiffPixels: 0,
    },
  },
  snapshotPathTemplate: "{testDir}/__snapshots__/{arg}{ext}",
  use: {
    browserName: "chromium",
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    baseURL: "http://localhost:6106",
  },
  webServer: {
    command: "node ../../scripts/serve-storybook-static.mjs",
    url: "http://localhost:6106/index.json",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
