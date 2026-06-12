import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./src/__tests__/setup-supertest.ts"],

    // Bumped above vitest defaults (5s test / 10s hook / 10s teardown)
    // because many suites here run against an embedded Postgres that
    // takes 6-12s to start on a loaded self-hosted runner and 1-3s to
    // finish each TRUNCATE-based cleanup. The default 10s hookTimeout
    // was the direct cause of 39 skipped tests in secrets-service.test.ts
    // on the 2026-05-18 verify_canary run 26007667963 — the suite's
    // beforeAll never reached the test bodies because embedded-postgres
    // startup raced past the hook deadline. Per-file overrides exist
    // (process-recovery sets beforeAll to 20s, watchdog sets afterEach
    // to 30s) but lifting the baseline avoids retrofitting every suite.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
