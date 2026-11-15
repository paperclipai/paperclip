import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const port = Number(process.env.SPEKO_NATIVE_TEST_PORT ?? 3480);
export default defineConfig({
  testDir: ".", testMatch: "integrated.spec.ts", workers: 1, fullyParallel: false, retries: 0,
  timeout: 360_000, expect: { timeout: 15_000 },
  outputDir: "./test-results", reporter: [["list"], ["html", { outputFolder: "./playwright-report", open: "never" }]],
  use: { serviceWorkers: "block", baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1200, height: 900 }, trace: "retain-on-failure" },
  webServer: {
    command: "server/node_modules/.bin/tsx tests/speko-native/server.ts", cwd: root,
    env: { ...process.env, SPEKO_NATIVE_WATCH: "0", SPEKO_NATIVE_STUB: "1", SPEKO_NATIVE_PORT: String(port), SPEKO_NATIVE_STUB_PORT: String(port + 1), SPEKO_NATIVE_CALLBACK_ORIGIN: "https://speko-fixture.invalid", SPEKO_NATIVE_INSTANCE_FILE: resolve(root, "tests/speko-native/.instance.json") },
    url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
