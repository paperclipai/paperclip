import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "sdk-real.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4193",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "pnpm exec vite --config vite.sdk.config.ts --host 127.0.0.1 --port 4193",
    env: {
      PAPERCLIP_LIVE_CONSOLE_DRIVER: "codex",
      PAPERCLIP_LIVE_CONSOLE_MAX_SESSIONS: "8",
      // The browser middleware creates its disposable working directory below
      // this run-owned root. Tell the nested Codex process about that exact
      // assignment so its workspace-boundary guard remains fail closed.
      PAPERCLIP_WORKSPACE_CWD:
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.cwd(),
    },
    url: "http://127.0.0.1:4193/reference-console/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
