import { defineConfig } from "vitest/config";
import {
  EMBEDDED_POSTGRES_HOOK_TIMEOUT_MS,
  EMBEDDED_POSTGRES_TEARDOWN_TIMEOUT_MS,
} from "../scripts/embedded-postgres-test-budget.mjs";

export default defineConfig({
  test: {
    environment: "node",
    // The CLI e2e suites boot embedded Postgres in beforeAll. Budget is
    // centralized in scripts/embedded-postgres-test-budget.mjs (RBR-918).
    hookTimeout: EMBEDDED_POSTGRES_HOOK_TIMEOUT_MS,
    teardownTimeout: EMBEDDED_POSTGRES_TEARDOWN_TIMEOUT_MS,
  },
});
