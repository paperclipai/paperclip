import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";
import { RunnerSequencer } from "./scripts/vitest-sequencer.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@paperclipai/paperclip-runner/react", replacement: resolve(packageRoot, "src/react/index.ts") },
      { find: "@paperclip-runner-local/capability", replacement: resolve(packageRoot, "src/scenarios/index.ts") },
    ],
  },
  test: {
    ...(process.env.PAPERCLIP_CI_PROFILE === "true"
      ? { reporters: [...configDefaults.reporters, resolve(packageRoot, "../../scripts/ci-profile/vitest-reporter.mjs")] }
      : {}),
    environment: "node",
    // Hermetic files also launch Runner and sidecar processes. Reserve CPU
    // capacity for their startup within the original readiness deadlines.
    ...(process.env.GITHUB_ACTIONS === "true"
      ? { maxWorkers: Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))) }
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
