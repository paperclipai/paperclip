import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "document-opener",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
