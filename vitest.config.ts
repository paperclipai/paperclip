import { defineConfig } from "vitest/config";
import { resolveRepoVitestMaxWorkers } from "./vitest.repo-cpu";

export default defineConfig({
  test: {
    maxWorkers: resolveRepoVitestMaxWorkers(),
    minWorkers: 1,
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
      "packages/adapters/grok-local",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/adapters/qwen-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
