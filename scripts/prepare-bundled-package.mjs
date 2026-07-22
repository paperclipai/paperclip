#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function materializePublishManifest(pkg) {
  const publishConfig = pkg.publishConfig ?? {};
  const publishManifest = { ...pkg };

  for (const key of ["main", "types", "exports", "bin"]) {
    if (publishConfig[key] !== undefined) publishManifest[key] = publishConfig[key];
  }

  delete publishManifest.publishConfig;
  return publishManifest;
}

export function prepareBundledPackage(sourceDir, destinationDir) {
  const sourcePackagePath = resolve(sourceDir, "package.json");
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
  const bundledDependencies = sourcePackage.bundleDependencies ?? sourcePackage.bundledDependencies ?? [];

  if (bundledDependencies.length === 0) {
    throw new Error(`${sourcePackage.name} does not declare bundled dependencies`);
  }

  execFileSync(
    "pnpm",
    ["--filter", sourcePackage.name, "deploy", "--prod", resolve(destinationDir)],
    { cwd: repoRoot, stdio: "inherit" },
  );

  const bundledRuntimeDependencies = materializeBundledNodeModules(
    resolve(destinationDir),
    bundledDependencies,
  );

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const deployedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
  deployedPackage.dependencies = {
    ...bundledRuntimeDependencies.dependencies,
    ...deployedPackage.dependencies,
  };
  deployedPackage.optionalDependencies = {
    ...bundledRuntimeDependencies.optionalDependencies,
    ...deployedPackage.optionalDependencies,
  };
  writeFileSync(
    deployedPackagePath,
    `${JSON.stringify(materializePublishManifest(deployedPackage), null, 2)}\n`,
  );
}

/**
 * pnpm deploy links dependencies through the `.pnpm` virtual store, but npm
 * only bundles physical directories, so a symlinked layout publishes a
 * tarball with zero bundled files and silently drops the patched runtime.
 * Rebuild node_modules as a minimal physical tree holding only the bundled
 * dependencies. Their runtime dependencies are promoted into the staged root
 * manifest so npm installs the normal transitive closure for consumers.
 */
export function materializeBundledNodeModules(destinationDir, bundledDependencies) {
  const stagedModules = resolve(destinationDir, "node_modules");
  const bundledSources = new Map(
    bundledDependencies.map((name) => [name, realpathSync(resolve(stagedModules, name))]),
  );

  const physicalModules = resolve(destinationDir, "node_modules.bundled-tmp");
  const runtimeDependencies = { dependencies: {}, optionalDependencies: {} };
  rmSync(physicalModules, { recursive: true, force: true });
  for (const [name, sourcePath] of bundledSources) {
    const bundledPackage = JSON.parse(readFileSync(resolve(sourcePath, "package.json"), "utf8"));
    Object.assign(runtimeDependencies.dependencies, bundledPackage.dependencies);
    Object.assign(runtimeDependencies.optionalDependencies, bundledPackage.optionalDependencies);

    const target = resolve(physicalModules, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(sourcePath, target, { recursive: true, dereference: true });
    rmSync(resolve(target, "node_modules"), { recursive: true, force: true });
  }

  rmSync(stagedModules, { recursive: true, force: true });
  renameSync(physicalModules, stagedModules);
  return runtimeDependencies;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, destinationDir] = process.argv.slice(2);
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir>");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir));
}
