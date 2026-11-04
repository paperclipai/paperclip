import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const port = 3482;
export default defineConfig({
  testDir: ".", testMatch: "authenticated.spec.ts", workers: 1, retries: 0, timeout: 90_000,
  outputDir: "./test-results-auth", reporter: [["list"], ["html", { outputFolder: "./playwright-report-auth", open: "never" }]],
  use: { baseURL: `http://127.0.0.1:${port}`, serviceWorkers: "block", trace: "off" },
  webServer: {
    command: "server/node_modules/.bin/tsx tests/speko-native/server.ts", cwd: root,
    env: { ...process.env, SPEKO_NATIVE_WATCH: "0", SPEKO_NATIVE_AUTH: "1", SPEKO_NATIVE_STUB: "1", SPEKO_NATIVE_PORT: String(port), SPEKO_NATIVE_STUB_PORT: String(port + 1), SPEKO_NATIVE_CALLBACK_ORIGIN: "https://speko-fixture.invalid", SPEKO_NATIVE_INSTANCE_FILE: resolve(root, "tests/speko-native/.auth-instance.json") },
    url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
