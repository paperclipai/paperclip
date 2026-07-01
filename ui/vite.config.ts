import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

// esbuild 0.28.x no longer supports lowering destructuring for Vite's legacy
// module target list; keep both production and dev prebundle paths on the
// modern baseline already expected by the app.
const UI_ESBUILD_TARGET = "es2022";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    target: UI_ESBUILD_TARGET,
    minify: "esbuild",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Split a small set of stable, eagerly-imported vendors out of the
        // main bundle. Anything not matched here (incl. mermaid, katex,
        // cytoscape, and other dynamically-imported deps) is left to vite's
        // default chunking so their existing lazy chunks stay intact.
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/react-router") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "react-vendor";
          }
          if (id.includes("/node_modules/@tanstack/")) return "query-vendor";
          if (
            id.includes("/node_modules/lexical/") ||
            id.includes("/node_modules/@lexical/") ||
            id.includes("/node_modules/@assistant-ui/")
          ) {
            return "editor-vendor";
          }
          if (
            id.includes("/node_modules/react-markdown/") ||
            /\/node_modules\/remark-/.test(id) ||
            /\/node_modules\/rehype-/.test(id) ||
            /\/node_modules\/micromark/.test(id) ||
            id.includes("/node_modules/unified/") ||
            /\/node_modules\/hast-/.test(id) ||
            /\/node_modules\/mdast-/.test(id)
          ) {
            return "markdown-vendor";
          }
          if (id.includes("/node_modules/@dnd-kit/")) return "dnd-vendor";
          if (id.includes("/node_modules/lucide-react/")) return "icons-vendor";
          return undefined;
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
  optimizeDeps: {
    esbuildOptions: {
      target: UI_ESBUILD_TARGET,
    },
  },
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
