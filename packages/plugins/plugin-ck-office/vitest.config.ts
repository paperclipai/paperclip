import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Most legacy CK Office tests use node:test and run as standalone TAP
    // files. Keep this Vitest project scoped to explicitly migrated tests.
    include: ["src/**/*.vitest.test.ts"],
  },
});
