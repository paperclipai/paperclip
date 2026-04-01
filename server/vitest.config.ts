import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000, // 15s para testes com I/O (git operations, filesystem)
  },
});
