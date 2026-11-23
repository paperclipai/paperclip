import os from "node:os";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      lexical: path.resolve(import.meta.dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    // Vitest defaults to cpus - 1 for forks (3 workers on 4-core CI, leaving a core idle).
    // Use 4 workers on 4-core runners (measured 32% faster on shard 1/2: 55.0s vs 80.7s)
    // and cap at 7 on 8+-core runners so 1 core remains free for the Vite transform server.
    maxWorkers: Math.min(7, Math.max(1, os.availableParallelism())),
    css: { include: [/motion-tokens\.css/] },
    setupFiles: ["./vitest.setup.ts"],
  },
});
