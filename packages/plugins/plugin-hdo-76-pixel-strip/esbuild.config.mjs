import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the HDO-76 pixel-strip plugin.
 *
 * The plugin-sdk's default bundler presets externalise
 * `@paperclipai/plugin-sdk` for the manifest but **bundle** it for
 * the worker. In this heartbeat's environment the SDK's transitive
 * `zod` and `@paperclipai/shared` resolutions fail (the symlinks
 * are missing because pnpm install is broken on this Windows host);
 * following the file-browser-example plugin's proven shape, the
 * worker is therefore compiled with `tsc` and only the UI bundle
 * uses esbuild.
 *
 * The manifest is bundled here. The UI bundle is also bundled here.
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

console.log("pixel-strip plugin: manifest + UI bundled into dist/");
console.log("worker is compiled by `tsc` — run `pnpm build:tsc` to refresh dist/worker.js");
