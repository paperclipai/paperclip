import { existsSync, readdirSync } from "node:fs";
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function resolveInlineStyleParserEntry() {
  const directEntry = path.resolve(__dirname, "./node_modules/inline-style-parser/cjs/index.js");
  if (existsSync(directEntry)) return directEntry;

  const pnpmStoreDir = path.resolve(__dirname, "../node_modules/.pnpm");
  if (!existsSync(pnpmStoreDir)) return directEntry;

  const packageStoreEntry = readdirSync(pnpmStoreDir).find((entry) => entry.startsWith("inline-style-parser@"));
  if (!packageStoreEntry) return directEntry;

  return path.join(
    pnpmStoreDir,
    packageStoreEntry,
    "node_modules",
    "inline-style-parser",
    "cjs",
    "index.js",
  );
}

const inlineStyleParserEntry = resolveInlineStyleParserEntry();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "inline-style-parser": inlineStyleParserEntry,
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    // WSL2 /mnt/ drives don't support inotify — fall back to polling so HMR works
    watch: process.cwd().startsWith("/mnt/") ? { usePolling: true, interval: 1000 } : undefined,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
});
