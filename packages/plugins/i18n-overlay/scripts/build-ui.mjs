// Bundle the plugin UI entry into a single self-contained ES module.
//
// WHY a bundle (not plain tsc output):
// The host loads plugin UI by *fetching the entry module's source text* and
// importing it from a `blob:` URL (see ui/src/plugins/slots.tsx —
// `importPluginModule` / `rewriteBareSpecifiers`). In that loader:
//   - Only BARE specifiers (`react`, `react-dom`, `react/jsx-runtime`,
//     `@paperclipai/plugin-sdk/ui`) are rewritten to host-provided shims.
//   - RELATIVE imports (`./Mount.js`, `../engine.js`, `../dictionary/...`)
//     are NOT rewritten, and resolve against the blob origin (the host page),
//     so they 404. Multi-file UI with relative imports cannot load.
//   - Raw JSON module imports are likewise unsupported in that path.
//
// So the UI entry must be a single file whose only imports are the bare
// specifiers the loader knows how to shim. We bundle Mount + engine + the
// inlined dictionary (esbuild's `json` loader) into `dist/ui/index.js`, with
// react and the SDK kept external as bare specifiers.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

await build({
  entryPoints: [path.join(pkgRoot, "src/ui/index.ts")],
  outfile: path.join(pkgRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  // Keep host-provided deps external; the host loader rewrites these bare
  // specifiers to its own shims at load time.
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"],
  loader: { ".json": "json" },
  logLevel: "info",
});
