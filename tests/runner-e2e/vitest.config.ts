import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "runner-e2e-support",
    globalSetup: ["./verified-provider-bundles.setup.mjs"],
    include: ["**/*.test.ts", "**/*.test.mjs"],
    // These use node:test and run separately in test:e2e:runner:unit.
    exclude: [...configDefaults.exclude, "native-completion-{checks,git-source,source-contract}.test.mjs", "artifact-budget.test.mjs", "chat-feature-testops-api.test.mjs", "chat-feature-testops-cli.test.mjs", "chat-feature-testops-results.test.mjs", "testops-chat-reporter.test.mjs", "chat-completion-testops-{api,contract}.test.mjs"],
    testTimeout: 30_000,
  },
});
