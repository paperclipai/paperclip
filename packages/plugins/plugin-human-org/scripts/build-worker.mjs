import { build } from "esbuild";

await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  packages: "bundle",
  logLevel: "info",
});
