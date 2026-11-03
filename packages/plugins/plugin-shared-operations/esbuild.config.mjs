import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
await Promise.all([presets.esbuild.worker, presets.esbuild.manifest, presets.esbuild.ui].map((options) => esbuild.build(options)));
