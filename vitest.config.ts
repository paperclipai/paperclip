import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/adapter-utils",
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
