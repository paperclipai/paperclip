import { defineConfig } from "vitest/config";

// Config for the starter kit. Defaults to the unit/integration suites.
// Run the eval/benchmark gate explicitly with `pnpm eval`
// (vitest run src/evals), which enforces the quality thresholds in
// src/evals/suites.ts via the `withinThreshold` assertion.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
