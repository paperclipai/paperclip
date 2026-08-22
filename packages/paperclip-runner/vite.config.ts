import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { phase2BrowserServerPlugin } from "./scripts/phase2-browser-server.mjs";
import { phase4bBrowserServerPlugin } from "./scripts/phase4b-browser-server.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(packageRoot, "devtools/browser"),
  plugins: [react(), phase2BrowserServerPlugin(), phase4bBrowserServerPlugin()],
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  // Vite's dev dependency optimizer has its own esbuild target. Keep it in
  // sync with the standalone browser build so Ajv is never downlevelled.
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  build: {
    outDir: resolve(packageRoot, "dist-browser"),
    emptyOutDir: true,
    // The standalone devtool targets current evergreen browsers. Keeping the
    // emitted syntax modern also avoids asking Vite to downlevel Ajv's runtime
    // validator, which recent esbuild releases intentionally do not support.
    target: "esnext",
  },
});
