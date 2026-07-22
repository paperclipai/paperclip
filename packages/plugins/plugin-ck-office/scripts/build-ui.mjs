import esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

// NodeNext source uses explicit `.js` specifiers on relative imports (so tsc resolves them); map those
// back to their `.tsx`/`.ts` source when bundling the UI with esbuild.
const tsxResolve = {
  name: "ts-js-resolve",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
      for (const ext of [".tsx", ".ts"]) {
        const candidate = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ext));
        if (fs.existsSync(candidate)) return { path: candidate };
      }
      return undefined;
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  // Force the automatic JSX runtime for ALL files (matches tsconfig "jsx": "react-jsx"). Without this,
  // esbuild falls back to the classic transform (React.createElement) for any file that imports from
  // "react" — but plugin bundles have no global React (the host shims react/jsx-runtime), so classic
  // output throws "failed to render". automatic emits host-shimmed jsx() calls instead.
  jsx: "automatic",
  external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"],
  plugins: [tsxResolve],
  logLevel: "info",
});
