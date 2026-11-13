import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "runner-e2e-support",
    // CI profiling records per-test timings, like the root and Runner package configs.
    ...(process.env.PAPERCLIP_CI_PROFILE === "true"
      ? { reporters: [...configDefaults.reporters, fileURLToPath(new URL("../../scripts/ci-profile/vitest-reporter.mjs", import.meta.url))] }
      : {}),
    globalSetup: ["./verified-provider-bundles.setup.mjs"],
    setupFiles: ["./compile-cache.setup.mjs"],
    include: ["**/*.test.ts", "**/*.test.mjs"],
    // These use node:test and run separately in test:e2e:runner:unit.
    exclude: [...configDefaults.exclude, "product-regression-testops.test.mjs", "reliability-testops.test.mjs", "native-completion-{checks,git-source,source-contract}.test.mjs", "artifact-budget.test.mjs", "chat-feature-testops-api.test.mjs", "chat-feature-testops-cli.test.mjs", "chat-feature-testops-results.test.mjs", "testops-chat-reporter.test.mjs", "chat-completion-testops-{api,contract}.test.mjs", "chat-full-catalog-testops-*.test.mjs", "chat-catalog-testops-streaming.test.mjs"],
    testTimeout: 30_000,
    ...(process.env.GITHUB_ACTIONS === "true" && !process.env.PAPERCLIP_UNIT_BOUNDARY_PROBE ? {
      reporters: [...configDefaults.reporters, ...(process.env.PAPERCLIP_CI_PROFILE === "true" ? [fileURLToPath(new URL("../../scripts/ci-profile/vitest-reporter.mjs", import.meta.url))] : []), fileURLToPath(new URL("./import-report.tmp.mjs", import.meta.url))],
      experimental: { importDurations: { limit: 100_000 } },
    } : {}),
  },
});
