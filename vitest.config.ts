import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several server/cli integration tests boot embedded Postgres + a real
    // server subprocess. With one worker pool shared across all projects, a
    // fully-parallel run on a typical dev machine (especially with the live
    // org also running) oversubscribes CPU/ports and makes those heavy tests
    // flake. Cap concurrency so they get enough headroom to start reliably.
    maxWorkers: 3,
    minWorkers: 1,
    projects: [
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
