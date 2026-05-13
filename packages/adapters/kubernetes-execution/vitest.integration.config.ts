import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 240_000,
    // Each integration test spins up its own kind cluster, so run them sequentially
    // to avoid Docker disk/CPU pressure.
    fileParallelism: false,
  },
});
