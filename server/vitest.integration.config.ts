import { defineConfig } from "vitest/config";

/**
 * Vitest config for slow integration tests that require external infrastructure
 * (kind clusters, embedded postgres, etc.).  Run with:
 *
 *   pnpm -w exec vitest run --config server/vitest.integration.config.ts <pattern>
 *
 * Intentionally NOT included in the main vitest.config.ts to avoid slowing
 * down the unit-test loop.
 */
export default defineConfig({
  test: {
    environment: "node",
    // kind cluster creation is inherently sequential (Docker resource pressure).
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // No supertest setup needed for infrastructure integration tests.
    setupFiles: [],
    include: ["src/__tests__/**/*.integration.test.ts", "src/__tests__/k8s-*.test.ts"],
  },
});
