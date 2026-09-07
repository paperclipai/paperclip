import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the vault read-bridge example plugin.
 *
 * Same shape as the pixel-strip example: manifest + UI bundled with
 * esbuild, worker compiled with `tsc`. See the comment in
 * `plugin-pixel-strip-example/esbuild.config.mjs` for the rationale.
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

console.log("vault-read-bridge example: manifest + UI bundled into dist/");
console.log("worker is compiled by `tsc` — run `pnpm build:tsc` to refresh dist/worker.js");
