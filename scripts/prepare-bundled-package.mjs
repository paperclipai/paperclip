#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeTargets = ["linux-x64", "darwin-arm64", "darwin-x64"];

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

  delete installManifest.devDependencies;

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!installManifest[section]) continue;
    installManifest[section] = Object.fromEntries(
      Object.entries(installManifest[section]).filter(([name]) => bundledDependencyNames.has(name)),
    );
    if (Object.keys(installManifest[section]).length === 0) delete installManifest[section];
  }

  return installManifest;
}

// npm consumers cannot inherit the workspace's pnpm overrides or patches.
// Materialize the already-qualified Codex bridge closure in the tarball,
// with overrides confined to the temporary, scripts-disabled producer graph.
export function configureBundledProviderOverrides(installManifest, bundledDependencies, rootPackage, profileData) {
  const result = structuredClone(installManifest);
  const selected = [];
  for (const [agent, serverPackage, runtimePackage] of [
    ["codex", "@agentclientprotocol/codex-acp", "@openai/codex"],
  ]) {
    if (!bundledDependencies.includes(serverPackage)) continue;
    const profile = profileData?.profiles?.[agent];
    if (profileData?.schema !== "paperclip.acpx-profiles.v1" || profile?.agentServerPackage !== serverPackage
      || profile.agentRuntimePackage !== runtimePackage || !/^\d+\.\d+\.\d+$/.test(profile.agentServerVersion ?? "")
      || !/^\d+\.\d+\.\d+$/.test(profile.agentRuntimeVersion ?? "")
      || result.dependencies?.[serverPackage] !== profile.agentServerVersion) {
      throw new Error(`Bundled ${agent} bridge must match its exact qualified profile`);
    }
    const selector = `${serverPackage}@${profile.agentServerVersion}>${runtimePackage}`;
    if (rootPackage.pnpm?.overrides?.[selector] !== profile.agentRuntimeVersion) {
      throw new Error(`Bundled ${agent} runtime override must match its qualified profile`);
    }
    const npmSelector = `${serverPackage}@${profile.agentServerVersion}`;
    if (result.overrides?.[npmSelector] !== undefined) {
      throw new Error(`Bundled ${agent} runtime has a conflicting producer override`);
    }
    const overrides = { [runtimePackage]: profile.agentRuntimeVersion };
    result.overrides = { ...result.overrides, [npmSelector]: overrides };
    selected.push({ agent, ...profile });
  }
  return { installManifest: result, profiles: selected };
}

const inside = (root, candidate) => {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

// Bundle the pinned JavaScript closure, never the producer's Codex executable.
// npm installs the official optional package for the consumer's own platform.
export function stageBundledProviderOptionalDependencies(destinationDir, publishManifest, profiles) {
  const graphRoot = resolve(destinationDir, "node_modules");
  if (realpathSync(graphRoot) !== graphRoot) throw new Error("Bundled Codex graph must be a canonical owned directory");
  const result = structuredClone(publishManifest), remove = new Set(), optional = {}, normalize = new Map();
  const profile = profiles.find(value => value.agent === "codex");
  if (profiles.length !== 1 || !profile) throw new Error("Bundled provider graph must contain its qualified Codex profile");
  const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];
  const declarations = Object.fromEntries(targets.map(target => [`${profile.agentRuntimePackage}-${target}`,
    `npm:${profile.agentRuntimePackage}@${profile.agentRuntimeVersion}-${target}`]));
  const ownedDirectory = directory => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(graphRoot, realpathSync(directory))) {
      throw new Error("Bundled Codex dependency escapes its producer graph");
    }
  };
  const manifestAt = directory => {
    const path = resolve(directory, "package.json"), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) {
      throw new Error("Bundled Codex dependency manifest must be a bounded regular file");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const bridgeDirectory = resolve(graphRoot, profile.agentServerPackage);
  ownedDirectory(bridgeDirectory);
  const bridge = manifestAt(bridgeDirectory);
  if (bridge.name !== profile.agentServerPackage || bridge.version !== profile.agentServerVersion) throw new Error("Bundled Codex bridge version mismatch");
  const issuer = createRequire(resolve(bridgeDirectory, "package.json"));
  const runtimeManifest = realpathSync(issuer.resolve(`${profile.agentRuntimePackage}/package.json`));
  if (!inside(graphRoot, runtimeManifest)) throw new Error("Bundled Codex runtime escapes its producer graph");
  let runtimeCount = 0, packageCount = 0;
  const pending = [{ directory: graphRoot, depth: 0 }];
  while (pending.length) {
    const { directory, depth } = pending.pop();
    if (depth > 64) throw new Error("Bundled Codex graph exceeds its depth limit");
    const packages = [];
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(".")) continue;
      const candidate = resolve(directory, entry); ownedDirectory(candidate);
      if (entry.startsWith("@")) {
        for (const child of readdirSync(candidate)) {
          const scoped = resolve(candidate, child); ownedDirectory(scoped); packages.push(scoped);
        }
      } else packages.push(candidate);
    }
    for (const packageDirectory of packages) {
      if (++packageCount > 20_000) throw new Error("Bundled Codex graph exceeds its package limit");
      const metadata = manifestAt(packageDirectory);
      const binding = basename(dirname(packageDirectory)) === "@openai" ? `@openai/${basename(packageDirectory)}` : null;
      if (binding?.startsWith("@openai/codex-")) {
        const target = binding.slice("@openai/codex-".length), [os, cpu] = target.split("-");
        if (!Object.hasOwn(declarations, binding) || ![binding, profile.agentRuntimePackage].includes(metadata.name)
          || metadata.version !== `${profile.agentRuntimeVersion}-${target}` || !metadata.os?.includes(os) || !metadata.cpu?.includes(cpu)) {
          throw new Error("Bundled Codex installed platform identity mismatch");
        }
        remove.add(packageDirectory);
        continue;
      }
      const nested = resolve(packageDirectory, "node_modules");
      if (lstatExists(nested)) { ownedDirectory(nested); pending.push({ directory: nested, depth: depth + 1 }); }
      if (binding !== profile.agentRuntimePackage) continue;
      if (metadata.name !== profile.agentRuntimePackage || metadata.version !== profile.agentRuntimeVersion) throw new Error("Bundled Codex runtime version mismatch");
      runtimeCount++;
      const delegated = metadata.optionalDependencies === undefined
        && Object.entries(declarations).every(([name, specifier]) => result.optionalDependencies?.[name] === specifier);
      if (!delegated && (Object.keys(metadata.optionalDependencies ?? {}).length !== targets.length
        || targets.some(target => metadata.optionalDependencies?.[`${profile.agentRuntimePackage}-${target}`] !== declarations[`${profile.agentRuntimePackage}-${target}`]))) {
        throw new Error("Bundled Codex platform declaration is not qualified");
      }
      if (!delegated) {
        const normalized = { ...metadata }; delete normalized.optionalDependencies;
        normalize.set(resolve(packageDirectory, "package.json"), normalized);
      }
      const vendor = resolve(packageDirectory, "vendor");
      if (lstatExists(vendor)) { ownedDirectory(vendor); remove.add(vendor); }
    }
  }
  if (!runtimeCount) throw new Error("Bundled Codex runtime omitted its platform declarations");
  for (const [name, specifier] of Object.entries(declarations)) {
    if (result.optionalDependencies?.[name] !== undefined && result.optionalDependencies[name] !== specifier) throw new Error(`Bundled Codex platform conflicts with published dependency: ${name}`);
    optional[name] = specifier;
  }
  // A bundled wrapper's optional edges make npm treat missing platform slots
  // as bundled too. Delegate those exact declarations to the unbundled server
  // root so normal npm can install the correct host version beside legacy deps.
  // Validate the complete graph before changing metadata or deleting payloads.
  for (const [path, metadata] of normalize) writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
  for (const directory of remove) rmSync(directory, { recursive: true, force: true });
  result.optionalDependencies = { ...result.optionalDependencies, ...optional };
  for (const field of ["bundleDependencies", "bundledDependencies"]) {
    if (Array.isArray(result[field])) result[field] = result[field].filter(name => !Object.hasOwn(declarations, name));
  }
  delete result.paperclipProviderArtifacts;
  return result;
}

function lstatExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// A Linux-produced bundle contains esbuild's JavaScript but only the producer's
// optional executable. Expose its exact platform declarations to the consumer,
// just as embedded-postgres does below, before retaining the original hooks.
export function stageBundledEsbuildOptionalDependencies(destinationDir, publishManifest) {
  const graphRoot = resolve(destinationDir, "node_modules");
  if (realpathSync(graphRoot) !== graphRoot) throw new Error("Bundled esbuild graph must be a canonical owned directory");
  const result = structuredClone(publishManifest), pending = [{ directory: graphRoot, depth: 0 }];
  const optional = {}, remove = new Set();
  let packageCount = 0;
  const ownedDirectory = directory => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(graphRoot, realpathSync(directory))) {
      throw new Error("Bundled esbuild dependency escapes its producer graph");
    }
  };
  const manifestAt = directory => {
    const file = resolve(directory, "package.json"), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) {
      throw new Error("Bundled esbuild dependency manifest must be a bounded regular file");
    }
    return JSON.parse(readFileSync(file, "utf8"));
  };
  while (pending.length) {
    const { directory, depth } = pending.pop();
    if (depth > 64) throw new Error("Bundled esbuild dependency graph exceeds its depth limit");
    const packages = [];
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(".")) continue;
      const candidate = resolve(directory, entry);
      ownedDirectory(candidate);
      if (entry.startsWith("@")) {
        for (const child of readdirSync(candidate)) {
          const scoped = resolve(candidate, child); ownedDirectory(scoped); packages.push(scoped);
        }
      } else packages.push(candidate);
    }
    for (const packageDirectory of packages) {
      if (++packageCount > 20_000) throw new Error("Bundled esbuild dependency graph exceeds its package limit");
      const metadata = manifestAt(packageDirectory);
      const nested = resolve(packageDirectory, "node_modules");
      if (lstatExists(nested)) { ownedDirectory(nested); pending.push({ directory: nested, depth: depth + 1 }); }
      if (basename(packageDirectory) !== "esbuild") continue;
      if (metadata.name !== "esbuild" || !/^\d+\.\d+\.\d+$/.test(metadata.version ?? "")) {
        throw new Error("Bundled esbuild package identity mismatch");
      }
      const declarations = metadata.optionalDependencies ?? {};
      if (nativeTargets.some(target => declarations[`@esbuild/${target}`] !== metadata.version)) {
        throw new Error("Bundled esbuild omitted a supported platform declaration");
      }
      const issuer = createRequire(resolve(packageDirectory, "package.json"));
      for (const [name, version] of Object.entries(declarations)) {
        if (!/^@esbuild\/[a-z0-9]+-[a-z0-9]+$/.test(name) || version !== metadata.version) {
          throw new Error("Bundled esbuild platform declaration must match its exact package version");
        }
        if ((optional[name] !== undefined && optional[name] !== version)
          || (result.optionalDependencies?.[name] !== undefined && result.optionalDependencies[name] !== version)) {
          throw new Error(`Bundled esbuild platform version conflicts with published dependency: ${name}`);
        }
        optional[name] = version;
        for (const lookup of issuer.resolve.paths(name) ?? []) {
          const candidate = resolve(lookup, name);
          if (!inside(graphRoot, candidate) || !lstatExists(candidate)) continue;
          ownedDirectory(candidate);
          const installed = manifestAt(candidate);
          if (installed.name !== name || installed.version !== version) {
            throw new Error(`Bundled esbuild installed platform identity mismatch: ${name}`);
          }
          remove.add(candidate);
        }
      }
    }
  }
  for (const directory of remove) rmSync(directory, { recursive: true, force: true });
  if (Object.keys(optional).length) result.optionalDependencies = { ...result.optionalDependencies, ...optional };
  return result;
}

function patchedDependencyPackageName(specifier) {
  const versionSeparator = specifier.lastIndexOf("@");
  const packageNameEnd = specifier.startsWith("@") ? specifier.indexOf("/") : 0;
  if (packageNameEnd < 0) return specifier;
  return versionSeparator > packageNameEnd ? specifier.slice(0, versionSeparator) : specifier;
}

export function selectBundledDependencyPatches(
  destinationDir,
  bundledDependencies,
  patchedDependencies,
) {
  const patchesByPackageName = new Map();
  for (const [specifier, patchPath] of Object.entries(patchedDependencies)) {
    const packageName = patchedDependencyPackageName(specifier);
    const packagePatches = patchesByPackageName.get(packageName) ?? new Map();
    packagePatches.set(specifier, patchPath);
    patchesByPackageName.set(packageName, packagePatches);
  }

  const selectedPatches = [];
  for (const packageName of new Set(bundledDependencies)) {
    const packagePatches = patchesByPackageName.get(packageName);
    if (!packagePatches) continue;

    const installedManifestPath = resolve(
      destinationDir,
      "node_modules",
      packageName,
      "package.json",
    );
    let installedManifest;
    try {
      installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: failed to read ${installedManifestPath}`,
        { cause },
      );
    }

    if (
      installedManifest.name !== packageName ||
      typeof installedManifest.version !== "string" ||
      installedManifest.version.length === 0
    ) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed package manifest must declare the expected name and a version`,
      );
    }

    const installedSpecifier = `${packageName}@${installedManifest.version}`;
    const patchPath = packagePatches.get(installedSpecifier);
    if (patchPath === undefined) {
      const configuredSpecifiers = [...packagePatches.keys()].sort().join(", ");
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed ${installedSpecifier}, but configured patches are ${configuredSpecifiers}`,
      );
    }
    if (typeof patchPath !== "string" || patchPath.length === 0) {
      throw new Error(`Patch path for ${installedSpecifier} must be a non-empty string`);
    }
    selectedPatches.push({ packageName, specifier: installedSpecifier, patchPath });
  }

  return selectedPatches;
}

export function applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot = repoRoot) {
  const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
  const patchedDependencies = rootPackage.pnpm?.patchedDependencies ?? {};

  for (const { packageName, patchPath } of selectBundledDependencyPatches(
    destinationDir,
    bundledDependencies,
    patchedDependencies,
  )) {
    execFileSync(
      "patch",
      ["-p1", "--forward", "-d", resolve(destinationDir, "node_modules", packageName)],
      {
        input: readFileSync(resolve(sourceRoot, patchPath)),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
}

export function prepareBundledPackage(sourceDir, destinationDir, { sourceRoot = repoRoot } = {}) {
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
  const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
  const profileData = bundledDependencies.includes("@agentclientprotocol/codex-acp")
    ? JSON.parse(readFileSync(resolve(sourceRoot, "packages/paperclip-runner/acpx-profiles.json"), "utf8")) : undefined;
  const { installManifest, profiles } = configureBundledProviderOverrides(
    createBundledInstallManifest(publishManifest, bundledDependencies), bundledDependencies, rootPackage, profileData,
  );
  writeFileSync(deployedPackagePath, `${JSON.stringify(installManifest, null, 2)}\n`);

  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: destinationDir, stdio: "inherit" },
  );
  writeFileSync(deployedPackagePath, `${JSON.stringify(publishManifest, null, 2)}\n`);
  applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot);
  if (profiles.length) writeFileSync(deployedPackagePath, `${JSON.stringify(stageBundledProviderOptionalDependencies(destinationDir, publishManifest, profiles), null, 2)}\n`);

  if (bundledDependencies.includes("acpx")) {
    const acpxPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/acpx/package.json"), "utf8"),
    );
    const expectedPatchMarker = {
      "0.12.0": "onAgentStderr",
      "0.13.1": "spawnEnvironment",
    }[acpxPackage.version];
    const acpxRuntime = readFileSync(
      resolve(destinationDir, "node_modules/acpx/dist/runtime.js"),
      "utf8",
    );
    if (!expectedPatchMarker || !acpxRuntime.includes(expectedPatchMarker)) {
      throw new Error(
        `staged acpx@${acpxPackage.version} runtime is missing the repository patch`,
      );
    }
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
  writeFileSync(deployedPackagePath, `${JSON.stringify(stageBundledEsbuildOptionalDependencies(destinationDir,
    JSON.parse(readFileSync(deployedPackagePath, "utf8"))), null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, destinationDir] = process.argv.slice(2);
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir>");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir));
}
