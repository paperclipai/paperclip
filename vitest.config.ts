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
      reporter: ["text", "text-summary", "lcov", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: [
        "server/src/**/*.ts",
        "cli/src/**/*.ts",
        "ui/src/**/*.ts",
        "packages/*/src/**/*.ts",
        "packages/adapters/*/src/**/*.ts",
      ],
      exclude: [
        "**/__tests__/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/node_modules/**",
        "**/dist/**",
        "**/*.d.ts",
        "**/migrations/**",
        "**/test-utils/**",
      ],
      reportOnFailure: true,
      thresholds: {
        lines: 30,
        functions: 25,
        branches: 25,
        statements: 30,
      },
    },
  },
});
