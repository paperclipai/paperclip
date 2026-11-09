import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  // Two 30s backoffs can each wait another scheduler tick, followed by the
  // three real 10s timeouts and the final no-fourth-run observation window.
  timeout: 240_000,
  use: { viewport: { width: 1440, height: 1080 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
  outputDir: "../../../test-results/workspace-bootstrap",
  reporter: [["list"]],
});
