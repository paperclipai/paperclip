import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    isolate: true,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: {
      forks: {
        isolate: true,
        maxForks: 1,
        minForks: 1,
      },
    },
    projects: [
      "packages/db",
      "packages/shared",
      "packages/adapter-utils",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
