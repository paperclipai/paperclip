import { defineConfig } from "tsup";

// Two entries run in parallel by tsup; clean is handled by the build script
// (rm -rf dist) rather than per-entry to avoid a race between the parallel builds.
export default defineConfig([
  {
    // Library entry for npm publish
    entry: { index: "src/index.ts" },
    format: ["esm"],
    outDir: "dist",
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
  },
  {
    // Standalone MCP server binary — @paperclipai/shared is bundled so `node dist/stdio.js`
    // works outside a pnpm workspace without needing to resolve workspace package exports.
    entry: { stdio: "src/stdio.ts" },
    format: ["esm"],
    outDir: "dist",
    noExternal: ["@paperclipai/shared"],
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
  },
]);
