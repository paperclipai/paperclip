import { defineConfig } from "vitest/config";
import {
  EMBEDDED_POSTGRES_HOOK_TIMEOUT_MS,
  EMBEDDED_POSTGRES_TEARDOWN_TIMEOUT_MS,
} from "../scripts/embedded-postgres-test-budget.mjs";

export default defineConfig({
  test: {
    environment: "node",
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. The boot (initdb + start + applyPendingMigrations)
    // costs ~92s on developer hardware, and the graceful shutdown under the
    // loaded serial shard (maxWorkers=1) can also run long. The budget is
    // centralized in scripts/embedded-postgres-test-budget.mjs (RBR-918) so it
    // cannot drift per-file: inline hook budgets win over --hookTimeout, so a
    // per-file value could not be corrected from CI configuration.
    hookTimeout: EMBEDDED_POSTGRES_HOOK_TIMEOUT_MS,
    teardownTimeout: EMBEDDED_POSTGRES_TEARDOWN_TIMEOUT_MS,
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
  },
});
