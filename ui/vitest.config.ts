import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Force Vite/Vitest to pick the development export for libraries that ship
    // separate dev/prod bundles via package.json `exports` conditions (e.g. all
    // `lexical*` packages). Without this, `lexical` and `@lexical/link` resolve
    // through their `Lexical*.mjs` runtime dispatcher that keys on
    // `process.env.NODE_ENV` — and the CI test runner (root `vitest.config.ts`
    // + `scripts/run-vitest-stable.mjs`) sets `NODE_ENV=test`, which makes the
    // dispatcher pull a mix of dev/prod singletons across `lexical` and
    // `@lexical/link` in the same worker. That mix surfaces as
    // "LexicalNode: Node LexicalNode does not implement .getType()". Pinning
    // the `development` condition keeps all lexical packages on the same dev
    // singleton, matching the React 19 dev build that is forced in
    // `vitest.setup.ts` to expose `act`. Tracked in KSI-712.
    conditions: ["development", "import", "module", "node", "default"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
