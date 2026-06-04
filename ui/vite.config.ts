import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    minify: "esbuild",
    rollupOptions: {
      output: {
        // Split heavy, slow-changing vendors into their own chunks so app-only
        // deploys keep them immutable-cached (hashed assets are served
        // Cache-Control: immutable). Without this the whole ~4MB bundle is one
        // file whose hash changes every deploy, forcing a full re-download.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|react-router|scheduler)\//.test(id)) return "react-vendor";
          if (id.includes("node_modules/mermaid")) return "mermaid";
          if (/node_modules\/(@mdxeditor|lexical|@lexical)\//.test(id)) return "editor";
          if (id.includes("node_modules/@assistant-ui")) return "chat";
          if (/node_modules\/(react-markdown|remark-|micromark|mdast|hast|unist|unified|vfile)/.test(id)) return "markdown";
          if (/node_modules\/(@radix-ui|radix-ui|cmdk)\//.test(id)) return "radix";
          if (id.includes("node_modules/@dnd-kit")) return "dnd";
          if (/node_modules\/(i18next|react-i18next)\//.test(id)) return "i18n";
          return "vendor";
        },
      },
    },
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
}));
