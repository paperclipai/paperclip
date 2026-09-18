import { defineConfig } from "@playwright/test";

/**
 * Focused browser suite for the Capability issue thread.
 *
 * The suite runs the built app through `vite preview` on loopback. Fake-mode
 * routes render from package fixtures, so no provider, runnerd, or Codex
 * process is started here.
 */
export default defineConfig({
  testDir: ".",
  testMatch: ["issue-thread.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4184",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      // Hosts without the Playwright chromium system libraries can point at a
      // preinstalled Chromium instead of running `pnpm verify:rootless`.
      ...(process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH === undefined
        ? {}
        : { executablePath: process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH }),
    },
  },
  webServer: [
    {
      command:
        "pnpm exec vite preview --config vite.issue-thread.config.ts --host 127.0.0.1 --port 4184",
      url: "http://127.0.0.1:4184",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Same app and same package server, with a scripted Codex provider, so
      // the streaming checks can drive a real NDJSON turn without a provider
      // process. See `vite.issue-thread-stream.config.ts`.
      command:
        "pnpm exec vite preview --config vite.issue-thread-stream.config.ts --host 127.0.0.1 --port 4185",
      url: "http://127.0.0.1:4185",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
