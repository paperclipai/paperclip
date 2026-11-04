import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 120_000,
  use: { baseURL: "http://127.0.0.1:4197", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: {
    command: "pnpm --filter @paperclipai/ui exec vite --host 127.0.0.1 --port 4197 --strictPort",
    url: "http://127.0.0.1:4197/tests/task-chat-perf.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
