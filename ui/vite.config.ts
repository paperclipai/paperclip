import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    process.env.ANALYZE && visualizer({
      filename: "dist/bundle-analysis.html",
      open: false,
      gzipSize: true,
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  esbuild: mode === "production" ? { drop: ["console", "debugger"], legalComments: "none" } : {},
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // MDX editor - loaded only when dialogs open
          if (id.includes("node_modules/@mdxeditor") || id.includes("node_modules/lexical") || id.includes("node_modules/@lexical")) {
            return "vendor-editor";
          }
          // Mermaid, cytoscape, katex: already lazy via MarkdownBody - let Vite split naturally
          // Core vendor chunks to reduce main bundle
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
            return "vendor-react";
          }
          if (id.includes("node_modules/react-router")) {
            return "vendor-router";
          }
          if (id.includes("node_modules/@tanstack/react-query")) {
            return "vendor-query";
          }
          if (id.includes("node_modules/@radix-ui") || id.includes("node_modules/radix-ui")) {
            return "vendor-radix";
          }
          if (id.includes("node_modules/lucide-react")) {
            return "vendor-ui";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
}));
