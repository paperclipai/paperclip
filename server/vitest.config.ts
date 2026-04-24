import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    isolate: true,
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
    },
  },
});
