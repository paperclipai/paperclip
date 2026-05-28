import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "server/index": "src/server/index.ts",
    "ui-parser": "src/ui-parser.ts",
  },
  format: ["esm"],
  outDir: "dist",
  // openai stays external — installed as a peer in the deployment environment
  // adapter-utils is bundled — it's an internal Paperclip dep versioned with the adapter
  external: ["openai"],
  noExternal: ["@paperclipai/adapter-utils"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
