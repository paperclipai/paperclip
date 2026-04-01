import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "packages/plugins/plugin-telegram",
      "packages/plugins/plugin-sentry",
      "packages/plugins/plugin-knowledge-base",
      "server",
      "ui",
      "cli",
    ],
  },
});
