import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const START_SCRIPT = path.join(__dirname, "start-paperclip-e2e.sh");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  retries: 0,
  workers: Number(process.env.PAPERCLIP_E2E_WORKERS ?? 1),
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // The webServer directive starts `paperclipai run` before tests.
  // Expects `pnpm paperclipai` to be runnable from repo root.
  webServer: {
    command: `bash ${START_SCRIPT}`,
    env: {
      ...process.env,
      PAPERCLIP_E2E_PORT: String(PORT),
    },
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: process.env.PAPERCLIP_E2E_REUSE_SERVER === "true",
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
