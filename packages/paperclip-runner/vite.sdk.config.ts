import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { liveConsoleBrowserServerPlugin } from "./scripts/live-console-browser-server.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(packageRoot, "examples"),
  plugins: [react(), liveConsoleBrowserServerPlugin()],
  resolve: {
    alias: [
      { find: "@paperclipai/paperclip-runner/browser", replacement: resolve(packageRoot, "src/browser/index.ts") },
      { find: "@paperclipai/paperclip-runner/react", replacement: resolve(packageRoot, "src/react/index.ts") },
      { find: "@paperclipai/paperclip-runner/styles.css", replacement: resolve(packageRoot, "styles.css") },
    ],
  },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: resolve(packageRoot, "dist-sdk"),
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        reference: resolve(packageRoot, "examples/reference-console/index.html"),
        mini: resolve(packageRoot, "examples/mini-consumer/index.html"),
      },
    },
  },
});
