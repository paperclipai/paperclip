import esbuild from "esbuild";
await esbuild.build({ entryPoints: ["src/worker.ts", "src/manifest.ts"], outdir: "dist", bundle: true, platform: "node", format: "esm", target: "node24", packages: "external" });
