import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname);

// Bundle the worker fully (including @paperclipai/plugin-sdk) so the forked
// worker process is self-contained and does not need to resolve the SDK's
// @paperclipai/shared source at runtime (shared exports src/*.ts which plain
// Node cannot execute). react stays external (host provides it); the SDK is
// bundled in so plugin workers run anywhere Paperclip forks them.
await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/worker.ts")],
  outfile: path.join(packageRoot, "dist/worker.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["react", "react-dom"],
  logLevel: "info",
});

console.log("Built self-contained worker bundle.");
