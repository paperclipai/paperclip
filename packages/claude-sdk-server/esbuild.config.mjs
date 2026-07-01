import esbuild from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  outdir: "dist",
  packages: "bundle",
  external: ["ws"],
};

await esbuild.build({
  ...shared,
  entryPoints: ["src/index.ts"],
});

await esbuild.build({
  ...shared,
  entryPoints: ["src/cli.ts"],
});
