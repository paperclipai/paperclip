// Plain vitest config for Task 5 scaffold smoke test.
// The workers-pool config (vitest.pool.config.ts) is committed for Task 6
// but requires workerd runtime download — falls back to this plain config here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.smoke.test.ts"],
    environment: "node",
  },
});
