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

  materializeBundledNodeModules(resolve(destinationDir), bundledDependencies);

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const deployedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
  writeFileSync(
    deployedPackagePath,
    `${JSON.stringify(materializePublishManifest(deployedPackage), null, 2)}\n`,
  );
}

/**
 * pnpm deploy links dependencies through the `.pnpm` virtual store, but npm
 * only bundles physical directories, so a symlinked layout publishes a
 * tarball with zero bundled files and silently drops the patched runtime.
 * Rebuild node_modules as a minimal physical tree holding exactly the
 * bundled dependencies.
 */
export function materializeBundledNodeModules(destinationDir, bundledDependencies) {
  const stagedModules = resolve(destinationDir, "node_modules");
  const bundledSources = new Map(
    bundledDependencies.map((name) => [name, realpathSync(resolve(stagedModules, name))]),
  );

  const physicalModules = resolve(destinationDir, "node_modules.bundled-tmp");
  rmSync(physicalModules, { recursive: true, force: true });
  for (const [name, sourcePath] of bundledSources) {
    const target = resolve(physicalModules, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(sourcePath, target, { recursive: true, dereference: true });
  }

  rmSync(stagedModules, { recursive: true, force: true });
  renameSync(physicalModules, stagedModules);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, destinationDir] = process.argv.slice(2);
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir>");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir));
}
