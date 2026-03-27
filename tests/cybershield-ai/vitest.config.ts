import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: __dirname,
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
