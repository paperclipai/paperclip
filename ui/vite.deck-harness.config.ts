import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: "public",
  build: {
    outDir: "deck-product-flow-static",
    emptyOutDir: true,
    copyPublicDir: true,
    manifest: true,
    rollupOptions: {
      input: path.resolve(__dirname, "deck-product-flow.html"),
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
});
