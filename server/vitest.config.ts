import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded-Postgres suites run initdb + pg_ctl start + migrations inside beforeAll.
    // A cold run (first vitest invocation after an install) exceeds the 20s default, and a
    // timed-out hook leaks the postmaster because cleanup never runs (ALAA-3702).
    hookTimeout: 120_000,
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
  },
});
