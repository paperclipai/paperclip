import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/adapter-utils",
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/gemini-local",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/shared",
      "server",
      "ui",
      "cli",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: [
        "packages/*/src/**/*.ts",
        "packages/adapters/*/src/**/*.ts",
        "server/src/**/*.ts",
        "ui/src/**/*.ts",
        "cli/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/__tests__/**",
        "**/node_modules/**",
        "**/*.d.ts",
      ],
      thresholds: {
        statements: 10,
        branches: 10,
        functions: 10,
        lines: 10,
      },
    },
  },
});
