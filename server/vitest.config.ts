import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI. Give
    // the boot/teardown hooks generous headroom; 30s is far above the observed
    // worst-case teardown yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
    server: {
      deps: {
        // drizzle-orm ships as type:"module" (ESM) and has internal circular
        // references that cause "Cannot require() ES Module ... in a cycle"
        // errors on Windows when vite-node loads it natively. Inlining it tells
        // vite-node to transform drizzle-orm (and all its sub-paths) through
        // Vite's pipeline, which resolves the cycles and makes it loadable.
        inline: [/drizzle-orm/],
      },
    },
  },
});
