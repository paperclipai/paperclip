import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { resolveVitestRootConfigContext } from "./scripts/vitest-root-config.mjs";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const rootConfig = resolveVitestRootConfigContext({ repoRoot });

export default defineConfig({
  resolve: {
    alias: rootConfig.alias,
  },
  test: {
    exclude: rootConfig.exclude,
    projects: rootConfig.projects,
    setupFiles: ["./scripts/vitest-setup-ensure-plugin-build-deps.mjs"],
  },
});
