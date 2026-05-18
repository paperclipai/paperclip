import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "scripts",
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
});
