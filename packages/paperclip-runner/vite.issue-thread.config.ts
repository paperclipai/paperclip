import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { capabilityIssueThreadServerPlugin } from "./scripts/capability-issue-thread-server.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  root: resolve(packageRoot, "devtools/issue-thread"),
  plugins: [react(), capabilityIssueThreadServerPlugin()],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: resolve(packageRoot, "dist-issue-thread"),
    emptyOutDir: true,
    target: "esnext",
    // Keep every WOFF2 inspectable in the built asset graph, including the
    // intentionally tiny supplemental-symbol subset.
    assetsInlineLimit: 0,
  },
});
