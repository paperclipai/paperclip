import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "bridge-template/src/**/*.test.ts"],
    environment: "node",
  },
});
