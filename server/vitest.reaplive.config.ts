import { defineConfig } from "vitest/config";

// RBR-979: the reap liveness tests are pure unit tests over an injected process
// table probe — no database, no server, no `ps`. The default server config boots
// embedded Postgres in globalSetup (~90s), which the standing execution
// constraints say not to pay for a narrow verification. This config runs the
// same test file with no globalSetup.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/reap-liveness.test.ts"],
    testTimeout: 30000,
  },
});
