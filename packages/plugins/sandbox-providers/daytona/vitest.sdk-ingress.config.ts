import path from "node:path";
import { defineConfig } from "vitest/config";
import config from "./vitest.config.js";

export default defineConfig({ ...config,
  test: { ...config.test, include: [path.join(import.meta.dirname, "src/runner-ingress.sdk-integration.ts")] },
});
