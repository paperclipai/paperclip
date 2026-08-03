import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";
import { createApiProxy } from "./src/lib/vite-api-proxy";

const apiProxy = createApiProxy();

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    minify: "esbuild",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        "onboarding-preview": path.resolve(__dirname, "onboarding-preview.html"),
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
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  server: {
    // Harness-managed preview servers assign a port via the PORT env var;
    // default stays 5173 for plain `vite` runs.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: apiProxy,
  },
  preview: {
    port: 3101,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: apiProxy,
  },
}));
