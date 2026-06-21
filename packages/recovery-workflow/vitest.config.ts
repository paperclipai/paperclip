// Plain vitest config for Task 5 scaffold smoke test and Task 6 hand-mocked unit tests.
// The workers-pool config (vitest.pool.config.ts) is committed for Task 6
// but requires workerd runtime download — falls back to this plain config here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.smoke.test.ts", "src/__tests__/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // Stub out cloudflare:workers so plain vitest/node tests can import
      // modules that re-export from src/index.ts without crashing.
      "cloudflare:workers": new URL(
        "./src/__tests__/__mocks__/cloudflare-workers.ts",
        import.meta.url
      ).pathname,
    },
  },
});
