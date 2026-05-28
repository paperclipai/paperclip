import path from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

/**
 * PTK-519 commit 3: convert render-blocking CSS to async preload with noscript
 * fallback. Applied post-build so it wraps whatever hash Vite emits.
 * Rollback: remove this plugin from the array.
 */
function asyncCssPlugin(): Plugin {
  return {
    name: "paperclip-async-css",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(
          /<link rel="stylesheet" crossorigin href="([^"]+\.css)">/g,
          (_, href) =>
            `<link rel="preload" as="style" href="${href}" onload="this.onload=null;this.rel='stylesheet'">\n    <noscript><link rel="stylesheet" href="${href}"></noscript>`
        );
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), asyncCssPlugin()],
  build: {
    minify: "esbuild",
    /**
     * PTK-519 commit 3: fail CI when any chunk exceeds 200 KB (unminified).
     * This catches accidental re-bundling of vendor code into app chunks.
     */
    chunkSizeWarningLimit: 200,
    rollupOptions: {
      output: {
        /**
         * PTK-519 commit 3: split stable vendor libraries into named chunks so
         * they can be cached independently of application code. Each group is
         * chosen for stability (rarely changes across releases).
         *
         * Rollback: remove the manualChunks key; Rollup reverts to automatic
         * splitting without any functional regression.
         */
        manualChunks(id) {
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/")
          ) {
            return "vendor-react";
          }
          if (id.includes("node_modules/react-router")) {
            return "vendor-router";
          }
          if (id.includes("node_modules/@tanstack/react-query")) {
            return "vendor-query";
          }
          if (
            id.includes("node_modules/lexical/") ||
            id.includes("node_modules/@lexical/")
          ) {
            return "vendor-lexical";
          }
          if (id.includes("node_modules/@mdxeditor/")) {
            return "vendor-mdxeditor";
          }
          if (
            id.includes("node_modules/radix-ui/") ||
            id.includes("node_modules/@radix-ui/")
          ) {
            return "vendor-radix";
          }
          if (id.includes("node_modules/lucide-react/")) {
            return "vendor-icons";
          }
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
