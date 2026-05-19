import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

import { loadHostEnv } from "./host-env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Host-side secrets: infra/.env → .env → REALLLM_EXTRA_ENV_FILE (CMP-531). */
loadHostEnv(process.cwd());

export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  timeout: 120_000,
  retries: 0,
  workers: 1,
  globalSetup: path.join(__dirname, "global-setup.ts"),
  globalTeardown: path.join(__dirname, "global-teardown.ts"),
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(__dirname, "playwright-report") }],
    ["junit", { outputFile: path.join(__dirname, "playwright-report", "junit.xml") }],
  ],
  outputDir: path.join(__dirname, "test-results"),
  projects: [{ name: "realllm", use: {} }],
});
