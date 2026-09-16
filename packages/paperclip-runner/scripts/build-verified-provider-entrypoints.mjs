import { chmod } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const verifiedProviderEntrypoints = Object.freeze([
  Object.freeze({
    name: "acpx-runtime-sidecar",
    source: resolve(packageRoot, "src/cli/acpx-runtime-sidecar.ts"),
    output: resolve(packageRoot, "dist/cli/acpx-runtime-sidecar.js"),
    verifiedOutput: resolve(packageRoot, "dist/cli/acpx-runtime-sidecar.cjs"),
  }),
  Object.freeze({
    name: "opencode-app-server-proxy",
    source: resolve(packageRoot, "src/cli/opencode-app-server-proxy.ts"),
    output: resolve(packageRoot, "dist/cli/opencode-app-server-proxy.js"),
    verifiedOutput: resolve(
      packageRoot,
      "dist/cli/opencode-app-server-proxy.cjs",
    ),
  }),
]);

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function assertSelfContainedBundle(entrypoint, result) {
  const outputs = Object.entries(result.metafile.outputs).filter(
    ([, output]) => output.entryPoint !== undefined,
  );
  if (outputs.length !== 1) {
    throw new Error(
      `${entrypoint.name} bundle emitted ${outputs.length} entrypoint outputs instead of one`,
    );
  }
  const imports = outputs[0][1].imports;
  for (const dependency of imports) {
    if (!dependency.external || !nodeBuiltins.has(dependency.path)) {
      throw new Error(
        `${entrypoint.name} bundle retained a non-builtin import: ${dependency.path}`,
      );
    }
  }
}

export async function bundleVerifiedProviderEntrypoints({ write = true } = {}) {
  const results = [];
  for (const entrypoint of verifiedProviderEntrypoints) {
    const buildBundle = async (outfile, format) => {
      const result = await build({
        entryPoints: [entrypoint.source],
        outfile,
        bundle: true,
        platform: "node",
        format,
        target: "node24",
        packages: "bundle",
        splitting: false,
        sourcemap: false,
        legalComments: "none",
        metafile: true,
        treeShaking: true,
        write,
        logLevel: "silent",
        banner:
          format === "cjs"
            ? {
                js: 'const __paperclipVerifiedEntrypointUrl = require("node:url").pathToFileURL(__filename).href;',
              }
            : undefined,
        define:
          format === "cjs"
            ? {
                "import.meta.dirname": "__dirname",
                "import.meta.url": "__paperclipVerifiedEntrypointUrl",
              }
            : undefined,
      });
      assertSelfContainedBundle(entrypoint, result);
      return result;
    };
    const result = await buildBundle(entrypoint.output, "esm");
    const verifiedResult = await buildBundle(entrypoint.verifiedOutput, "cjs");
    if (write && process.platform !== "win32") {
      await Promise.all([
        chmod(entrypoint.output, 0o755),
        chmod(entrypoint.verifiedOutput, 0o755),
      ]);
    }
    results.push({ entrypoint, result, verifiedResult });
  }
  return results;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  await bundleVerifiedProviderEntrypoints();
}
