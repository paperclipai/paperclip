import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { lanes } from "./inventory.mjs";
const root = resolve(import.meta.dirname, "../..");
const requested = process.env.LIFECYCLE_BASELINE_LAYER ?? "unit";
if (!(requested in lanes))
  throw new Error(`Unknown baseline layer: ${requested}`);
const lane = requested as keyof typeof lanes;
export default defineConfig({
  root,
  resolve: {
    alias: [
      {
        find: /^@paperclipai\/paperclip-runner$/,
        replacement: resolve(root, "packages/paperclip-runner/src/index.ts"),
      },
    ],
  },
  test: {
    name: `lifecycle-baseline-${lane}`,
    environment: "node",
    include: lanes[lane].files,
    setupFiles: [resolve(root, "server/src/__tests__/setup-supertest.ts")],
    testTimeout: lane === "integration" ? 60_000 : 30_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    pool: "forks",
    sequence: { concurrent: false, hooks: "list" },
  },
});
