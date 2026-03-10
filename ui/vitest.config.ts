import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The current UI tests cover pure route helpers and do not require a DOM.
    // Keep the environment in Node until we add component-rendering tests.
    environment: "node",
  },
});
