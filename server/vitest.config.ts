import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@paperclipai\/paperclip-runner\/live$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/live/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@paperclipai\/paperclip-runner$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI. Give
    // the boot/teardown hooks generous headroom; 30s is far above the observed
    // worst-case teardown yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    // The route/authz suites import very large modules (for example
    // src/routes/issues.ts and its dependency graph). The first test in each
    // file can pay the one-time Vite transform cost inside its own timeout
    // budget. Under file-parallel CI shards (up to 5 workers sharing Vite's
    // transform server on 8-core runners, with --retry=0 on Cloud Readiness),
    // simultaneous cold transforms regularly cross 15s and fail the first test,
    // which also lets fire-and-forget wakes leak into the next test. Match
    // hookTimeout/teardownTimeout at 30s so cold module loading never flakes
    // while genuinely hung tests still fail well inside the 20 minute job limit.
    testTimeout: 30000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    pool: "forks",
    // Server suites share process state and one embedded Postgres instance,
    // so tests inside a file must run one at a time. Do not set
    // sequence.concurrent to true.
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
