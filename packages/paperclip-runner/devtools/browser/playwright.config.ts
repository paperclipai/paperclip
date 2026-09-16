import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["static-replay.spec.ts", "live-console.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command:
      "pnpm exec vite preview --config vite.config.ts --host 127.0.0.1 --port 4179",
    env: {
      // Keep streamed chunks slow enough that interrupt races are reachable
      // from a test, and fast enough that the suite stays quick.
      PAPERCLIP_LIVE_CONSOLE_CHUNK_DELAY_MS: "60",
      // One server serves the whole suite, and every test leaves its session
      // behind when its page closes, so the interactive default of 16 is
      // exhausted partway through.
      PAPERCLIP_LIVE_CONSOLE_MAX_SESSIONS: "64",
    },
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
