import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
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
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
    // Ensure shadow-mode env is always off in tests; the done-gate test suite
    // re-enables it explicitly per-test via vi.resetModules() + dynamic import.
    env: {
      DONE_GATE_SHADOW_MODE: "false",
    },
  },
});
