#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const packageJsonPath = join(packageDir, "package.json");
const devPackageJsonPath = join(packageDir, "package.dev.json");

function findRepoRoot(startDir) {
  let current = startDir;
  while (current !== dirname(current)) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    current = dirname(current);
  }
  return null;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function collectWorkspaceVersions(repoRoot) {
  const roots = ["packages", "server", "ui", "cli"];
  const versions = new Map();

  function walk(relDir) {
    const absDir = join(repoRoot, relDir);
    if (!existsSync(absDir)) return;

    const pkgPath = join(absDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg.name && pkg.version) {
        versions.set(pkg.name, pkg.version);
      }
      return;
    }

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      walk(join(relDir, entry.name));
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return versions;
}

function rewriteWorkspaceDeps(deps, workspaceVersions) {
  if (!deps) return deps;
  return Object.fromEntries(
    Object.entries(deps).map(([name, version]) => {
      if (typeof version !== "string" || !version.startsWith("workspace:")) {
        return [name, version];
      }

      const resolvedVersion = workspaceVersions.get(name);
      if (!resolvedVersion) {
        throw new Error(`Cannot resolve workspace dependency ${name} for publish package`);
      }
      return [name, resolvedVersion];
    }),
  );
}

const pkg = readJson(packageJsonPath);
const publishConfig = pkg.publishConfig ?? {};

if (existsSync(devPackageJsonPath)) {
  throw new Error(`Refusing to overwrite existing ${devPackageJsonPath}`);
}

if (!publishConfig.exports) {
  throw new Error(`${pkg.name} is missing publishConfig.exports`);
}

const repoRoot = findRepoRoot(packageDir);
const workspaceVersions = repoRoot ? collectWorkspaceVersions(repoRoot) : new Map();

renameSync(packageJsonPath, devPackageJsonPath);

const nextPublishConfig = { ...publishConfig };
delete nextPublishConfig.exports;
delete nextPublishConfig.main;
delete nextPublishConfig.types;

const publishPkg = {
  ...pkg,
  exports: publishConfig.exports,
  main: publishConfig.main,
  types: publishConfig.types,
  publishConfig: nextPublishConfig,
  dependencies: rewriteWorkspaceDeps(pkg.dependencies, workspaceVersions),
  optionalDependencies: rewriteWorkspaceDeps(pkg.optionalDependencies, workspaceVersions),
  peerDependencies: rewriteWorkspaceDeps(pkg.peerDependencies, workspaceVersions),
};

writeFileSync(packageJsonPath, `${JSON.stringify(publishPkg, null, 2)}\n`);
