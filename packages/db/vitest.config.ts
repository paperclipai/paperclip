import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // See server/vitest.config.ts: a cold embedded-Postgres start exceeds the 20s default
    // and a timed-out hook leaks the postmaster (ALAA-3702).
    hookTimeout: 120_000,
  },
});
