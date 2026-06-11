import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // A handful of route/workspace integration tests boot embedded Postgres or
    // server subprocesses and can flake under parallel contention even with the
    // global worker cap. They pass deterministically in isolation, so a bounded
    // retry absorbs residual contention without masking real failures.
    retry: 2,
  },
});
