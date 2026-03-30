import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Capped to reduce embedded-postgres and git worktree contention; full suite is often flaky at default CPU parallelism.
    maxWorkers: 4,
    projects: ["packages/db", "packages/adapters/opencode-local", "server", "ui", "cli"],
  },
});
