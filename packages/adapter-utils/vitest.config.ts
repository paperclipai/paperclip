import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    environment: "node",
  },
});
