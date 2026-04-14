import path from "path";
import { defineConfig } from "vitest/config";

const inlineStyleParserEntry = path.resolve(
  __dirname,
  "./node_modules/inline-style-parser/cjs/index.js",
);

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
