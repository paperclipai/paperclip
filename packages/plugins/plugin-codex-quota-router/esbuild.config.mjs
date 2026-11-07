import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets();
await Promise.all([
  esbuild.build(presets.esbuild.worker),
  esbuild.build(presets.esbuild.manifest),
]);
