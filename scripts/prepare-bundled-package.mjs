#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function materializePublishManifest(pkg) {
  const publishConfig = pkg.publishConfig ?? {};
  const publishManifest = { ...pkg };

  for (const key of ["main", "types", "exports", "bin"]) {
    if (publishConfig[key] !== undefined) publishManifest[key] = publishConfig[key];
  }

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!publishManifest[section]) continue;
    publishManifest[section] = Object.fromEntries(
      Object.entries(publishManifest[section]).map(([name, specifier]) => {
        if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) return [name, specifier];
        const range = specifier.slice("workspace:".length);
        const prefix = range === "^" || range === "~" ? range : "";
        return [name, `${prefix}${pkg.version}`];
      }),
    );
  }

  delete publishManifest.publishConfig;
  return publishManifest;
}

export function createBundledInstallManifest(publishManifest, bundledDependencies) {
  const bundledDependencyNames = new Set(bundledDependencies);
  const installManifest = structuredClone(publishManifest);

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!installManifest[section]) continue;
    installManifest[section] = Object.fromEntries(
      Object.entries(installManifest[section]).filter(([name]) => bundledDependencyNames.has(name)),
    );
    if (Object.keys(installManifest[section]).length === 0) delete installManifest[section];
  }

  return installManifest;
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

  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of sourcePackage.files ?? []) {
    cpSync(resolve(sourceDir, entry), resolve(destinationDir, entry), { recursive: true });
  }
  for (const entry of ["README.md", "LICENSE", "LICENSE.md"]) {
    const sourcePath = resolve(sourceDir, entry);
    if (existsSync(sourcePath)) cpSync(sourcePath, resolve(destinationDir, entry));
  }

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const publishManifest = materializePublishManifest(sourcePackage);
  const installManifest = createBundledInstallManifest(publishManifest, bundledDependencies);
  writeFileSync(deployedPackagePath, `${JSON.stringify(installManifest, null, 2)}\n`);

  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: destinationDir, stdio: "inherit" },
  );
  writeFileSync(deployedPackagePath, `${JSON.stringify(publishManifest, null, 2)}\n`);
  applyBundledDependencyPatches(destinationDir, bundledDependencies);

  if (
    bundledDependencies.includes("acpx") &&
    !readFileSync(resolve(destinationDir, "node_modules/acpx/dist/runtime.js"), "utf8").includes(
      "onAgentStderr",
    )
  ) {
    throw new Error("staged acpx runtime is missing the repository patch");
  }

  if (bundledDependencies.includes("embedded-postgres")) {
    const embeddedPostgresSource = readFileSync(
      resolve(destinationDir, "node_modules/embedded-postgres/dist/index.js"),
      "utf8",
    );
    if (
      !embeddedPostgresSource.includes("const LC_MESSAGES_LOCALE = 'C';") ||
      !embeddedPostgresSource.includes("globalThis.process.env")
    ) {
      throw new Error("staged embedded-postgres runtime is missing the repository patch");
    }

    const embeddedPostgresPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/embedded-postgres/package.json"), "utf8"),
    );
    const stagedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
    stagedPackage.optionalDependencies = {
      ...(stagedPackage.optionalDependencies ?? {}),
      ...(embeddedPostgresPackage.optionalDependencies ?? {}),
    };
    writeFileSync(deployedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
    rmSync(resolve(destinationDir, "node_modules/@embedded-postgres"), { recursive: true, force: true });
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
