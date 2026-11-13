import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/unit/**/*.test.ts",
      ...(process.env.RUN_K8S_INTEGRATION_TESTS === "1" ? ["test/integration/**/*.test.ts"] : []),
    ],
    testTimeout: process.env.RUN_K8S_INTEGRATION_TESTS === "1" ? 120_000 : 5_000,
    environment: "node",
  },
});
