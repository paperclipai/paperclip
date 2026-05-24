import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.{ts,tsx}"],
    environment: "node",
  },
  esbuild: {
    jsx: "automatic",
  },
});
