/**
 * Bundles the connector into one file. The shared protocol module is inlined,
 * so the published binary/container needs only `ws` at runtime.
 */
/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/main.js",
  banner: { js: "#!/usr/bin/env node" },
  external: ["ws"],
  treeShaking: true,
  sourcemap: true,
};
