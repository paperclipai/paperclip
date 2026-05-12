import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/acpx-local",
      "packages/adapters/codebuddy-local",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-cloud",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/adapters/qwen-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
