#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

function patchedDependencyPackageName(specifier) {
  const versionSeparator = specifier.lastIndexOf("@");
  return versionSeparator > 0 ? specifier.slice(0, versionSeparator) : specifier;
}

export function applyBundledDependencyPatches(destinationDir, bundledDependencies) {
  const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const patchedDependencies = rootPackage.pnpm?.patchedDependencies ?? {};
  const bundledDependencyNames = new Set(bundledDependencies);

  for (const [specifier, patchPath] of Object.entries(patchedDependencies)) {
    const packageName = patchedDependencyPackageName(specifier);
    if (!bundledDependencyNames.has(packageName)) continue;

    execFileSync(
      "patch",
      ["-p1", "--forward", "-d", resolve(destinationDir, "node_modules", packageName)],
      {
        input: readFileSync(resolve(repoRoot, patchPath)),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
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

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const deployedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
  writeFileSync(
    deployedPackagePath,
    `${JSON.stringify(materializePublishManifest(deployedPackage), null, 2)}\n`,
  );

  rmSync(resolve(destinationDir, "node_modules"), { recursive: true, force: true });
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: destinationDir, stdio: "inherit" },
  );
  applyBundledDependencyPatches(destinationDir, bundledDependencies);

  if (
    bundledDependencies.includes("acpx") &&
    !readFileSync(resolve(destinationDir, "node_modules/acpx/dist/runtime.js"), "utf8").includes(
      "onAgentStderr",
    )
  ) {
    throw new Error("staged acpx runtime is missing the repository patch");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, destinationDir] = process.argv.slice(2);
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir>");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir));
}
