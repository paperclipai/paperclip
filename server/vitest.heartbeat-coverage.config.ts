import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["src/**/heartbeat*.test.ts"],
      coverage: {
        provider: "v8",
        include: ["src/services/heartbeat.ts"],
        reporter: ["text", "json", "json-summary"],
        reportsDirectory: "coverage/heartbeat",
        thresholds: {
          lines: 100,
          branches: 100,
        },
      },
    },
  }),
);
