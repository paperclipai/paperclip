import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "runner-e2e-support",
    include: ["**/*.test.ts"],
    testTimeout: 30_000,
  },
});
