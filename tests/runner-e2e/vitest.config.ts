import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "runner-e2e-support",
    include: ["**/*.test.ts", "**/*.test.mjs"],
    // These use node:test and run separately in test:e2e:runner:unit.
    exclude: [...configDefaults.exclude, "native-completion-{checks,git-source,source-contract}.test.mjs"],
    testTimeout: 30_000,
  },
});
