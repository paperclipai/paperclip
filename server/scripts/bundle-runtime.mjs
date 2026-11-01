
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverDir = join(scriptDir, "..");

const REQUIRE_SHIM = "import { createRequire as __paperclipCreateRequire } from 'node:module'; const require = __paperclipCreateRequire(import.meta.url);";

export function preserveModuleLocation(source, file) {
  return source
    .replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(file).href))
    .replace(/\bimport\.meta\.dirname\b/g, JSON.stringify(dirname(file)))
    .replace(/\bimport\.meta\.filename\b/g, JSON.stringify(file));
}

function runtimeEntry(entry) {
  return {
    name: "runtime-entry",
    setup(builder) {
      builder.onResolve({ filter: /^paperclip-runtime-entry$/ }, () => ({ path: "paperclip-runtime-entry", namespace: "runtime-entry" }));
      builder.onLoad({ filter: /.*/, namespace: "runtime-entry" }, () => ({
        contents: `process.argv[1] = ${JSON.stringify(entry)};\nawait import(${JSON.stringify(entry)});\n`,
        loader: "js",
        resolveDir: dirname(entry),
      }));
    },
  };
}

const keepModuleLocations = {
  name: "keep-module-locations",
  setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?js|[cm]?ts)$/ }, async (args) => {
      if (args.path.includes("/node_modules/")) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta")) return undefined;
      return {
        contents: preserveModuleLocation(source, args.path),
        loader: /\.[cm]?ts$/.test(args.path) ? "ts" : "js",
        resolveDir: dirname(args.path),
      };
    });
  },
};

function externalizeThirdParty(isBundled, runtimeDir) {
  return {
    name: "externalize-third-party",
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData?.externalizeThirdParty || isBundled(args.path)) return undefined;
        const resolved = await builder.resolve(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          importer: args.importer,
          pluginData: { externalizeThirdParty: true },
        });
        if (resolved.errors.length > 0 || resolved.external) return { path: args.path, external: true };
        const fromServer = await builder.resolve(args.path, {
          kind: args.kind,
          resolveDir: runtimeDir,
          pluginData: { externalizeThirdParty: true },
        });
        if (fromServer.errors.length === 0 && fromServer.path === resolved.path) return { path: args.path, external: true };
        return { path: resolved.path, external: true };
      });
    },
  };
}

export async function bundleRuntime({ entry, outdir, maintenanceEntry, isBundled = (specifier) => specifier.startsWith("@paperclipai/") }) {
  await rm(outdir, { recursive: true, force: true });
  const result = await build({
    entryPoints: { index: "paperclip-runtime-entry", server: entry, ...(maintenanceEntry ? { "agent-files": maintenanceEntry } : {}) },
    outdir,
    outExtension: { ".js": ".mjs" },
    chunkNames: "chunk-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    mainFields: ["main"],
    conditions: ["node"],
    banner: { js: REQUIRE_SHIM },
    sourcemap: "linked",
    metafile: true,
    logLevel: "error",
    plugins: [runtimeEntry(entry), keepModuleLocations, externalizeThirdParty(isBundled, dirname(entry))],
  });
  const outputs = Object.keys(result.metafile.outputs).filter((file) => file.endsWith(".mjs"));
  return {
    outfile: join(outdir, "index.mjs"),
    serverModule: join(outdir, "server.mjs"),
    inputs: Object.keys(result.metafile.inputs).length,
    chunks: outputs.length,
  };
}

async function main() {
  const started = performance.now();
  const summary = await bundleRuntime({ entry: join(serverDir, "dist", "index.js"), outdir: join(serverDir, "dist-runtime"),
    maintenanceEntry: join(serverDir, "dist", "maintenance", "agent-files.js") });
  console.log(`[bundle-runtime] ${summary.inputs} inputs -> ${summary.chunks} chunks in ${Math.round(performance.now() - started)} ms: ${summary.outfile}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
