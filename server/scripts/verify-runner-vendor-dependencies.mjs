// Verify every npm package the vendored paperclip-runner actually imports
// at runtime is also declared as a direct dependency of server/package.json.
//
// packages/paperclip-runner is private and never published, so the server
// build vendors its compiled dist/ tree wholesale with `cp -R` (see the
// `build` script's `... dist/vendor/paperclip-runner/` step) -- code only,
// no node_modules alongside it. Every npm package the vendored code
// actually imports is therefore also a runtime dependency of server once
// vendored, and has to be declared there too (see acpx, ajv). That mirror
// step is easy to forget -- it silently missed smol-toml in #13110, and CI
// stayed green while production crash-looped 3 seconds into every start
// (#13116) -- because nothing enforced it.
//
// This derives the required set from esbuild's own module-resolution scan
// of the two entry points server actually imports (index.js, testing.js),
// with `write: false` so nothing is written to disk and `packages:
// "external"` so npm imports are reported, not inlined. That is precise:
// paperclip-runner declares dependencies (react-markdown, the codex/opencode
// CLI packages, ...) that only its unrelated ./react and ./browser export
// subpaths use, which server never imports, so requiring *every* declared
// dependency to be mirrored would be over-broad and demand dependencies
// server does not actually need.
//
// This intentionally only analyzes the module graph; it does not bundle or
// rewrite anything on disk. Several runner modules resolve sibling build
// artifacts -- the native runnerd binary, the ACPX/OpenCode CJS sidecar
// scripts in dist/cli, JSON replay fixtures under a top-level protocol/
// directory -- via `import.meta.url`-relative filesystem paths rather than
// JS imports, each at whatever nesting depth its source file happens to
// sit at. Actually bundling those entry points (an earlier version of this
// fix did) collapses and rearranges that layout, silently breaking those
// lookups. Preserving the original `cp -R` tree 1:1 is what keeps all of
// them working, so this script only verifies; it never restructures.

import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerRoot = resolve(serverRoot, "../packages/paperclip-runner");
const runnerDist = resolve(runnerRoot, "dist");

// The only entry points server/src actually imports from the vendored
// runner (server/src/**/*.ts import "../vendor/paperclip-runner/index.js"
// or ".../testing.js").
const ENTRY_POINT_NAMES = ["index.js", "testing.js"];

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/** The npm package name a bare import specifier resolves to, honoring scoped packages and subpaths. */
function packageNameFromSpecifier(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

export function findMissingVendorDependencies(importedPackageNames, declaredDependencyNames) {
  return [...importedPackageNames]
    .filter((name) => !declaredDependencyNames.has(name))
    .sort();
}

export async function findRunnerExternalPackages(entryPoints) {
  for (const entryPoint of entryPoints) {
    if (!existsSync(entryPoint)) {
      throw new Error(
        `paperclip-runner vendor check: expected build output at ${entryPoint}. ` +
          `Run "pnpm --filter @paperclipai/paperclip-runner build" first.`,
      );
    }
  }

  // write: false means this never touches disk -- it's a module-graph scan,
  // not a real bundle. Vendoring itself still happens via `cp -R` elsewhere
  // in the build script. `outdir` is required by esbuild for multiple entry
  // points but nothing is ever written there, so any sibling path will do.
  const result = await build({
    entryPoints,
    outdir: resolve(dirname(entryPoints[0]), ".vendor-dependency-scan"),
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });

  const externalPackageNames = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external) continue;
      if (imported.path.startsWith(".") || NODE_BUILTINS.has(imported.path)) continue;
      externalPackageNames.add(packageNameFromSpecifier(imported.path));
    }
  }
  return externalPackageNames;
}

function readDependencyNames(packageJsonPath) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return new Map(Object.entries(packageJson.dependencies ?? {}));
}

function explainMissingDependencies(missing, runnerDependencyNames) {
  const lines = missing.map((name) => {
    const range = runnerDependencyNames.get(name);
    return range
      ? `  "${name}": "${range}"  (matches packages/paperclip-runner/package.json)`
      : `  "${name}"  (not declared as a paperclip-runner dependency either -- check for a missing or mistyped dependency there first)`;
  });
  return (
    `paperclip-runner vendor check: server/package.json is missing the runtime ` +
    `${missing.length === 1 ? "dependency" : "dependencies"} the vendored runner ` +
    `imports at runtime:\n${lines.join("\n")}\n\n` +
    `packages/paperclip-runner/dist is copied into server's own published package ` +
    `without its node_modules, so every npm package the runner imports must also be ` +
    `a direct dependency of server so it resolves once vendored. Add ` +
    `${missing.length === 1 ? "it" : "them"} to server/package.json's "dependencies".`
  );
}

async function main() {
  const entryPoints = ENTRY_POINT_NAMES.map((name) => resolve(runnerDist, name));
  const externalPackageNames = await findRunnerExternalPackages(entryPoints);
  const serverDependencyNames = readDependencyNames(resolve(serverRoot, "package.json"));

  const missing = findMissingVendorDependencies(
    externalPackageNames,
    new Set(serverDependencyNames.keys()),
  );
  if (missing.length > 0) {
    const runnerDependencyNames = readDependencyNames(resolve(runnerRoot, "package.json"));
    throw new Error(explainMissingDependencies(missing, runnerDependencyNames));
  }
}

// Only run when invoked directly (`node scripts/verify-runner-vendor-dependencies.mjs`),
// not when the vitest suite imports findMissingVendorDependencies for a unit test.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
