import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],

    // Match the server config (PR #56). The default 5s testTimeout was
    // flaking React component tests that pay a cold-module-import cost
    // on the first test of each file — most visible in
    // CompanyAccess.test.tsx on the 2026-05-18 verify_canary run
    // 26011982864:
    //   × keeps the page human-focused and explains implicit versus
    //     explicit grants — Test timed out in 5000ms.
    //     (took 5545ms locally — barely over the 5s cap)
    // Bumping the baseline to 30s test / 60s hook prevents this without
    // per-test overrides. Per-file overrides remain MORE specific and
    // continue to take precedence.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
