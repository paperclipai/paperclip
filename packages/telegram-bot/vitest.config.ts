import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    pool: "forks",
    poolOptions: {
      forks: {
        isolate: true,
        maxForks: 1,
        minForks: 1,
      },
    },
    sequence: {
      concurrent: false,
      hooks: "list",
    },
  },
});
