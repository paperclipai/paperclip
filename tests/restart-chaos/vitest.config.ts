import { defineConfig } from "vitest/config";

/** Credential-free unit tests only; the harness itself is run by main.ts. */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "restart-chaos-unit",
    include: ["**/*.test.ts"],
    exclude: ["results/**", "node_modules/**"],
    testTimeout: 30_000,
  },
});
