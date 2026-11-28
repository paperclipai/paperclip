import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";
import { RunnerSequencer } from "./scripts/vitest-sequencer.mjs";
import { retryReporterEnabled, vitestRetryCount } from "../../scripts/ci/vitest-retry.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const ciReporters = [
  ...(process.env.GITHUB_ACTIONS === "true" ? [resolve(packageRoot, "../../scripts/ci/oversized-test-files.mjs")] : []),
  ...(process.env.PAPERCLIP_CI_PROFILE === "true" ? [resolve(packageRoot, "../../scripts/ci-profile/vitest-reporter.mjs")] : []),
  ...(retryReporterEnabled() ? [resolve(packageRoot, "../../scripts/ci/retry-reporter.mjs")] : []),
];
// One retry in PR CI only (run-pr-vitest-lane.mjs runs `vitest run` here
// without the root wrapper); see scripts/ci/vitest-retry.mjs.
const retry = vitestRetryCount();

function resolveRunnerCiMaxWorkers() {
  const override = process.env.PAPERCLIP_RUNNER_VITEST_MAX_WORKERS?.trim();
  if (override) {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  const cpus = Math.max(1, availableParallelism());
  // Hermetic files launch Runner and sidecar child processes; reserve 1 core
  // on 4-core runners (3 workers) and 2 cores on 8-core runners (6 workers).
  return cpus <= 4 ? Math.min(3, Math.max(1, cpus - 1)) : Math.min(6, cpus - 2);
}

export default defineConfig({
  resolve: {
    alias: [
      { find: "@paperclipai/paperclip-runner/react", replacement: resolve(packageRoot, "src/react/index.ts") },
      { find: "@paperclip-runner-local/capability", replacement: resolve(packageRoot, "src/scenarios/index.ts") },
    ],
  },
  test: {
    ...(ciReporters.length > 0 ? { reporters: [...configDefaults.reporters, ...ciReporters] } : {}),
    ...(retry > 0 ? { retry } : {}),
    environment: "node",
    ...(process.env.GITHUB_ACTIONS === "true"
      ? { maxWorkers: resolveRunnerCiMaxWorkers() }
      : {}),
    sequence: { sequencer: RunnerSequencer },
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "devtools/browser/src/**/*.test.ts",
      "devtools/issue-thread/src/**/*.test.ts",
      "devtools/issue-thread/src/**/*.test.tsx",
      "examples/scenario-explorer/src/**/*.test.ts",
      "examples/scenario-explorer/src/**/*.test.tsx",
      "scripts/local-runner-browser-server.test.mjs",
      "scripts/live-console-browser-server.test.mjs",
      "scripts/vitest-sequencer.test.mjs",
    ],
  },
});
