import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const inlineStyleParserEntry = path.resolve(
  __dirname,
  "./node_modules/inline-style-parser/cjs/index.js",
);

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
