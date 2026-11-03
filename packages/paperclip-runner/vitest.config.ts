import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

import { parseShardWeights, SHARD_WEIGHTS_ENV, weightedShard } from "./scripts/vitest-shard-weights.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

// Without the weights variable this is Vitest's ordinary equal sharding.
class WeightedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    const weights = shard ? parseShardWeights(process.env[SHARD_WEIGHTS_ENV], shard.count) : null;
    if (!shard || !weights) return super.shard(files);
    return weightedShard(files, (spec: TestSpecification) => relative(root, spec.moduleId).replaceAll("\\", "/"), shard.index, weights);
  }
}

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
    sequence: { sequencer: WeightedShardSequencer },
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
    ],
  },
});
