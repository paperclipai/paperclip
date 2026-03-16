import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/shared", "packages/db", "packages/adapters/opencode-local", "server", "ui", "cli"],
  },
});
