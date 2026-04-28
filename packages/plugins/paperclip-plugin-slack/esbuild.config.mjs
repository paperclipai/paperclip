import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets();
const watch = process.argv.includes("--watch");

// Override the manifest preset to bundle so the dist manifest is fully
// self-contained. The default preset uses bundle: false because most
// manifests are pure-data; ours pulls in tool-declarations.ts which
// transitively imports the SDK type. Bundling collapses everything into
// dist/manifest.js with no external runtime imports.
const manifestOpts = {
  ...presets.esbuild.manifest,
  bundle: true,
  external: ["react", "react-dom"],
};

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(manifestOpts);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch()]);
  console.log("esbuild watch mode enabled for worker and manifest");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose()]);
}
