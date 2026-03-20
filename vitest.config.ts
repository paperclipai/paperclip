import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/db", "packages/adapters/opencode-local", "packages/adapters/kiro-local", "server", "ui", "cli"],
  },
});
