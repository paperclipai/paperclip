import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["src/__tests__/helpers/disable-http-keepalive.ts"],
    retry: 2,
  },
});
