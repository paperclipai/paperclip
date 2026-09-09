// Bundle the private @paperclipai/paperclip-runner runtime into
// dist/vendor/paperclip-runner for the published server package.
//
// paperclip-runner is `private: true` and is never published, so its
// compiled code has to travel inside the published server package instead
// of being resolved as a normal npm dependency at install time. The build
// used to `cp -R` the runner's raw compiled dist/ tree wholesale — code
// only, no node_modules alongside it. Every runtime dependency the runner
// code imports then had to be re-declared by hand in this package's own
// `dependencies` (see acpx, ajv) so it would still resolve once vendored.
// That mirroring step was easy to forget — see the smol-toml incident in
// #13110/#13116 — because nothing enforced it, so the server crash-looped
// in production long after CI stayed green.
//
// This script bundles the runner's public entry points with esbuild
// instead, marking every node_modules import external via esbuild's
// `packages: "external"`. esbuild's metafile then reports, precisely,
// which npm packages the bundle actually needs at runtime — and this
// script fails the build if any of them isn't declared in
// server/package.json, instead of trusting a human to have remembered.

import { build } from "esbuild";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(serverRoot, "..");
const runnerRoot = resolve(repoRoot, "packages/paperclip-runner");
const runnerDist = resolve(runnerRoot, "dist");
const vendorOutDir = resolve(serverRoot, "dist/vendor/paperclip-runner");

// The only entry points server/src actually imports from the vendored
// runner (server/src/**/*.ts import "../vendor/paperclip-runner/index.js"
// or ".../testing.js"). The runner also publishes ./evals, ./live,
// ./devtools, ./browser, ./react and ./standalone subpaths, but none of
// those are reachable from server code, so they're left out of the bundle.
const ENTRY_POINT_NAMES = ["index.js", "testing.js"];

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function readDependencyNames(packageJsonPath) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return new Map(Object.entries(packageJson.dependencies ?? {}));
}

/** The npm package name a bare import specifier resolves to, honoring scoped packages and subpaths. */
function packageNameFromSpecifier(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

export function findMissingVendorDependencies(externalPackageNames, declaredDependencyNames) {
  return [...externalPackageNames]
    .filter((name) => !declaredDependencyNames.has(name))
    .sort();
}

async function bundleRunnerEntryPoints() {
  const entryPoints = ENTRY_POINT_NAMES.map((name) => resolve(runnerDist, name));
  for (const entryPoint of entryPoints) {
    if (!existsSync(entryPoint)) {
      throw new Error(
        `paperclip-runner vendor bundle: expected build output at ${entryPoint}. ` +
          `Run "pnpm --filter @paperclipai/paperclip-runner build" first.`,
      );
    }
  }

  const result = await build({
    entryPoints,
    outdir: vendorOutDir,
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    sourcemap: true,
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

function copyRunnerBinary() {
  const binSource = resolve(runnerDist, "bin");
  // Absent when the local build has no Rust toolchain (e.g. TypeScript-only
  // dev environments). native-codex-runner.ts falls back to the workspace
  // dist/bin location in that case, so it's fine to skip vendoring here.
  if (!existsSync(binSource)) return;
  const binDestination = resolve(vendorOutDir, "bin");
  cpSync(binSource, binDestination, { recursive: true });
  for (const entry of readdirSync(binDestination)) {
    const entryPath = resolve(binDestination, entry);
    if (statSync(entryPath).isFile()) chmodSync(entryPath, 0o755);
  }
}

function explainMissingDependencies(missing, runnerDependencyNames) {
  const lines = missing.map((name) => {
    const range = runnerDependencyNames.get(name);
    return range
      ? `  "${name}": "${range}"  (matches packages/paperclip-runner/package.json)`
      : `  "${name}"  (not declared as a paperclip-runner dependency either — check for a missing or mistyped dependency there first)`;
  });
  return (
    `paperclip-runner vendor bundle: server/package.json is missing the runtime ` +
    `${missing.length === 1 ? "dependency" : "dependencies"} the vendored runner needs at runtime:\n` +
    `${lines.join("\n")}\n\n` +
    `packages/paperclip-runner/dist is bundled into server's own published package ` +
    `without its node_modules, so every npm package the runner imports must also be a ` +
    `direct dependency of server so it resolves once vendored. Add ` +
    `${missing.length === 1 ? "it" : "them"} to server/package.json's "dependencies".`
  );
}

async function main() {
  rmSync(vendorOutDir, { recursive: true, force: true });
  mkdirSync(vendorOutDir, { recursive: true });

  const externalPackageNames = await bundleRunnerEntryPoints();
  copyRunnerBinary();

  const serverDependencyNames = readDependencyNames(resolve(serverRoot, "package.json"));
  const missing = findMissingVendorDependencies(externalPackageNames, new Set(serverDependencyNames.keys()));
  if (missing.length > 0) {
    const runnerDependencyNames = readDependencyNames(resolve(runnerRoot, "package.json"));
    throw new Error(explainMissingDependencies(missing, runnerDependencyNames));
  }
}

// Only run when invoked directly (`node scripts/bundle-runner-vendor.mjs`),
// not when the vitest suite imports findMissingVendorDependencies for a unit
// test — otherwise importing this module would trigger a real esbuild run.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
