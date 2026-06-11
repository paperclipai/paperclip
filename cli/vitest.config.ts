import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The company import/export e2e tests spin up embedded Postgres + a real
    // server subprocess and allocate an ephemeral port (listen(0) then bind).
    // Under the full parallel suite that port allocation can race with another
    // worker, so these otherwise-deterministic tests flake. They pass reliably
    // in isolation; a bounded retry absorbs the contention without masking real
    // failures (a genuine break fails every attempt).
    retry: 2,
  },
});
