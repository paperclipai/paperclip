import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "devtools/browser/src/**/*.test.ts",
      "scripts/phase2-browser-server.test.mjs",
      "scripts/phase4b-browser-server.test.mjs",
    ],
  },
});
