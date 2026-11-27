import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const pendingDependabotLock = process.env.PAPERCLIP_CI_PR_AUTHOR === "dependabot[bot]";
// Thread workers reuse the main process and V8 compile cache across the 699
// support test files while keeping strict per-file isolation (`isolate: true`)
// for the 100+ suites using `vi.mock`. Scale to 4 workers on 4-core runners
// (vs Vitest's default `cpus - 1 = 3` forks) and 7 workers on 8-core runners.
const maxWorkers = Math.min(7, Math.max(1, availableParallelism()));

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "runner-e2e-support",
    pool: "threads",
    maxWorkers,
    // CI profiling records per-test timings, like the root and Runner package configs.
    ...(process.env.PAPERCLIP_CI_PROFILE === "true"
      ? { reporters: [...configDefaults.reporters, fileURLToPath(new URL("../../scripts/ci-profile/vitest-reporter.mjs", import.meta.url))] }
      : {}),
    globalSetup: ["./verified-provider-bundles.setup.mjs"],
    include: ["**/*.test.ts", "**/*.test.mjs"],
    // These use node:test and run separately in test:e2e:runner:unit.
    exclude: [...configDefaults.exclude, "product-regression-testops.test.mjs", "reliability-testops.test.mjs", "native-completion-{checks,git-source,source-contract}.test.mjs", "artifact-budget.test.mjs", "chat-feature-testops-api.test.mjs", "chat-feature-testops-cli.test.mjs", "chat-feature-testops-results.test.mjs", "testops-chat-reporter.test.mjs", "chat-completion-testops-{api,contract}.test.mjs", "chat-full-catalog-testops-*.test.mjs", "chat-catalog-testops-streaming.test.mjs",
      ...(pendingDependabotLock ? ["source-sdk-public-type.test.ts"] : [])],
    testTimeout: 30_000,
  },
});
