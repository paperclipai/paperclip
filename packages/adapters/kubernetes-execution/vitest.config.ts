import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["test/integration/**", "**/node_modules/**", "**/dist/**"],
  },
});
