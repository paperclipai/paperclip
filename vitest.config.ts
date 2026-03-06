import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/db", "server", "ui", "cli"],
  },
});
