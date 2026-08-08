import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../../../..");

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      "@paperclipai/plugin-sdk": path.resolve(dirname, "../../sdk/src/index.ts"),
    },
  },
  test: {
    include: ["packages/plugins/sandbox-providers/daytona/src/**/*.test.ts"],
    environment: "node",
  },
});
