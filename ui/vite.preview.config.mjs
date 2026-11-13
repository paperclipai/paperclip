import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the standalone connect-step mock (`connect-model-preview.html`) on its
 * own, for deploying as a static page that a reviewer can open from a link.
 *
 * A separate config rather than a second rollup input on the app's build, and
 * the reason is what ends up on the host rather than tidiness: a shared build
 * emits the app's ~6MB `main` chunk into the same `dist/assets`, and every file
 * in the deployed directory is publicly fetchable whether or not anything links
 * to it. Building alone means the deployed bundle is this screen and the pieces
 * it composes, full stop. It also leaves the app's own build untouched.
 *
 *   pnpm --filter @paperclipai/ui build:preview
 */

const OUT_DIR = "dist-preview";

/**
 * Land the entry as `index.html` so the mock is the site root and the output
 * directory deploys as-is — no rename step to forget on a redeploy.
 *
 * Renamed on disk in `closeBundle` rather than rekeyed in `generateBundle`:
 * Vite's own HTML plugin emits the document after user plugins have had their
 * `generateBundle` turn, so a bundle-level rename finds nothing to rename. The
 * document's asset links are absolute (`/assets/...`), so moving the file
 * itself breaks nothing.
 */
const previewAsIndex = {
  name: "preview-html-as-index",
  closeBundle() {
    const built = path.resolve(__dirname, OUT_DIR, "connect-model-preview.html");
    if (!fs.existsSync(built)) return;
    fs.renameSync(built, path.resolve(__dirname, OUT_DIR, "index.html"));
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), previewAsIndex],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    minify: "esbuild",
    rollupOptions: {
      input: path.resolve(__dirname, "connect-model-preview.html"),
    },
  },
  esbuild: {
    drop: ["console", "debugger"],
    legalComments: "none",
  },
});
