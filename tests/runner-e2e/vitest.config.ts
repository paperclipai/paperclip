import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "runner-e2e-support",
    include: ["**/*.test.ts", "**/*.test.mjs"],
    testTimeout: 30_000,
  },
});
