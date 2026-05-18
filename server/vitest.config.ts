import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@paperclipai/adapter-codex-local/server": path.resolve(
        __dirname,
        "../packages/adapters/codex-local/src/server/index.ts",
      ),
      "@paperclipai/adapter-utils/server-utils": path.resolve(
        __dirname,
        "../packages/adapter-utils/src/server-utils.ts",
      ),
    },
  },
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: {
      forks: {
        isolate: true,
        maxForks: 1,
        minForks: 1,
      },
    },
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: [path.resolve(__dirname, "./src/__tests__/setup-supertest.ts")],
  },
});
