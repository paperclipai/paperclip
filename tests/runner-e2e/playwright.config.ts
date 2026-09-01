import path from "node:path";
import { defineConfig } from "@playwright/test";
import { runnerE2EWebServerCommand } from "./web-server-command.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(required("PAPERCLIP_RUNNER_E2E_PORT"));
const temporaryRoot = required("PAPERCLIP_RUNNER_E2E_TEMP_ROOT");
const privateDir = required("PAPERCLIP_RUNNER_E2E_PRIVATE_DIR");
const paperclipHome = required("PAPERCLIP_HOME");
const configPath = required("PAPERCLIP_CONFIG");
const baseURL = `http://127.0.0.1:${port}`;
required("PAPERCLIP_INSTANCE_ID");
required("PAPERCLIP_AGENT_JWT_SECRET");
required("PAPERCLIP_DECISION_SIGNING_SECRET");
required("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET");
required("BETTER_AUTH_SECRET");
if (
  !paperclipHome.startsWith(`${temporaryRoot}${path.sep}`) ||
  !configPath.startsWith(`${temporaryRoot}${path.sep}`)
) {
  throw new Error("Paperclip server paths escape the isolated temporary root");
}
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: ".",
  testMatch: "runner.spec.ts",
  timeout: Number(process.env.PAPERCLIP_RUNNER_E2E_TEST_TIMEOUT_MS ?? 600_000),
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    // Do not put an env object here: Playwright serializes webServer config in
    // blob reports. The wrapper inherits the test process and strips provider
    // keys before spawning the real Paperclip process.
    command: runnerE2EWebServerCommand(repositoryRoot),
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: path.join(privateDir, "playwright-output"),
  reporter: [
    ["list"],
    ["blob", { outputDir: path.join(privateDir, "blob-report") }],
    ["junit", { outputFile: path.join(privateDir, "junit.xml") }],
    [
      "html",
      { open: "never", outputFolder: path.join(privateDir, "html-report") },
    ],
  ],
});
