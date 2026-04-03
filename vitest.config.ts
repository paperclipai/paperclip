import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["server/src/**/*.ts", "packages/*/src/**/*.ts", "cli/src/**/*.ts"],
      exclude: ["**/__tests__/**", "**/*.test.ts", "**/dist/**"],
    },
  },
});
