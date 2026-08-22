import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";
import { createApiProxy } from "./src/lib/vite-api-proxy";

const apiProxy = createApiProxy();
// Plugin UI bundles are served by the backend at /_plugins/:id/ui/*.
// Without this, the dev server's SPA fallback returns index.html for those
// dynamic imports, so the browser parses HTML as JS ("Unexpected token '<'")
// and plugin UI (e.g. thinkstack.mc-liveness) fails to load in preview.
const pluginUiProxy = {
  "/_plugins": {
    target: "http://localhost:3100",
  },
};
const proxy = { ...apiProxy, ...pluginUiProxy };

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    minify: "esbuild",
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
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy,
  },
  preview: {
    port: 3101,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy,
  },
}));
