import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "runner-acceptance",
    include: ["**/*.test.ts"],
    environment: "node",
  },
});
