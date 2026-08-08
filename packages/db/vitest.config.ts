import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    server: {
      deps: {
        // drizzle-orm ships as type:"module" (ESM) and has internal circular
        // references that cause "Cannot require() ES Module ... in a cycle"
        // errors on Windows when vite-node loads it natively. Inlining it tells
        // vite-node to transform drizzle-orm (and all its sub-paths) through
        // Vite's pipeline, which resolves the cycles and makes it loadable.
        inline: [/drizzle-orm/],
      },
    },
  },
});
