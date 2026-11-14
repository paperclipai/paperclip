import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "src/__tests__/database-backup-checkpoint-qualification.integration.ts",
      "src/__tests__/database-backup-restore-guard.integration.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
