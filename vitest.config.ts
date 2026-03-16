import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the root test matrix authoritative so no real suites are excluded
    // from the default verification command.
    projects: [
      "packages/db",
      "packages/shared",
      "packages/adapter-utils",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "server",
      "ui",
      "cli",
      "scripts",
    ],
  },
});
