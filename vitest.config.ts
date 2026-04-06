import { defineConfig } from "vitest/config";

const defaultMaxWorkers = process.env.CI ? "50%" : "2";
const maxWorkers = process.env.PAPERCLIP_VITEST_MAX_WORKERS ?? defaultMaxWorkers;

export default defineConfig({
  test: {
    maxWorkers,
    minWorkers: 1,
    projects: [
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
