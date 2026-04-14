import { existsSync, readdirSync } from "node:fs";
import path from "path";
import { defineConfig } from "vitest/config";

function resolveInlineStyleParserEntry() {
  const directEntry = path.resolve(__dirname, "./node_modules/inline-style-parser/cjs/index.js");
  if (existsSync(directEntry)) return directEntry;

  const pnpmStoreDir = path.resolve(__dirname, "../node_modules/.pnpm");
  if (!existsSync(pnpmStoreDir)) return directEntry;

  const packageStoreEntry = readdirSync(pnpmStoreDir).find((entry) => entry.startsWith("inline-style-parser@"));
  if (!packageStoreEntry) return directEntry;

  return path.join(
    pnpmStoreDir,
    packageStoreEntry,
    "node_modules",
    "inline-style-parser",
    "cjs",
    "index.js",
  );
}

const inlineStyleParserEntry = resolveInlineStyleParserEntry();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "inline-style-parser": inlineStyleParserEntry,
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    server: {
      deps: {
        inline: ["react-markdown", "style-to-js", "style-to-object", "inline-style-parser"],
      },
    },
  },
});
