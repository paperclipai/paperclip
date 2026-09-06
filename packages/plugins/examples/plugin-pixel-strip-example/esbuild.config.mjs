import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the pixel-strip example plugin.
 *
 * Following the file-browser-example plugin's proven shape, the
 * worker is compiled with `tsc` and only the manifest and UI bundle
 * use esbuild. The plugin-sdk is externalised for the manifest
 * bundle so the host can resolve it at runtime.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname);

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/manifest.ts")],
  outfile: path.join(packageRoot, "dist/manifest.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["@paperclipai/plugin-sdk", "@paperclipai/shared"],
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
  ],
  logLevel: "info",
});

console.log("pixel-strip example: manifest + UI bundled into dist/");
console.log("worker is compiled by `tsc` — run `pnpm build:tsc` to refresh dist/worker.js");
