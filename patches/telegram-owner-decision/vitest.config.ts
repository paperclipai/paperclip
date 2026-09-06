import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "telegram-owner-decision",
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
