import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 20_000,
    isolate: true,
    testTimeout: 30_000,
  },
});
