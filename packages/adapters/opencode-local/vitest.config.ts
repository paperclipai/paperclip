import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only run source tests; never the compiled copies tsc emits into dist/.
    include: ["src/**/*.test.ts"],
  },
});
