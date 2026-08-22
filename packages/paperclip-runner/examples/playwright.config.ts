import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "phase5.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4192",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "pnpm exec vite --config vite.phase5.config.ts --host 127.0.0.1 --port 4192",
    env: {
      PAPERCLIP_PHASE4B_CHUNK_DELAY_MS: "250",
      PAPERCLIP_PHASE4B_MAX_SESSIONS: "64",
    },
    url: "http://127.0.0.1:4192/reference-console/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
