import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Tests share a .test-runtime/ cleanup directory; run files sequentially
    // to avoid ENOTEMPTY race on Windows when multiple files remove the same root.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
