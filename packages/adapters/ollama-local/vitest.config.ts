import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests boot ephemeral HTTP servers and use short socket
    // timeouts; the default 5s timeout is tight on loaded CI runners.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
