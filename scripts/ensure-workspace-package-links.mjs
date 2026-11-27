#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".paperclip",
  ".storybook",
  "__tests__",
  "coverage",
  "dist",
  "migrations",
  "node_modules",
  "provider-assets",
  "public",
  "src",
  "stories",
  "target",
  "test",
  "tests",
]);

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function discoverWorkspacePackagePaths(rootDir = repoRoot) {
  const packagePaths = new Map();

  function visit(dirPath) {
    if (!existsSync(dirPath)) return;
    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  for (const root of ["packages", "server", "ui", "cli"]) {
    visit(path.join(rootDir, root));
  }

  return packagePaths;
}

export function findWorkspaceLinkMismatches(workspaceDir, workspacePackagePaths, rootDir = repoRoot) {
  const nodeModulesDir = path.join(rootDir, workspaceDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    return [];
  }

  const packageJson = readJsonFile(path.join(rootDir, workspaceDir, "package.json"));
  const dependencies = {
    ...(packageJson.dependencies ?? undefined),
    ...(packageJson.devDependencies ?? undefined),
  };
  const mismatches = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;

    const linkPath = path.join(rootDir, workspaceDir, "node_modules", ...packageName.split("/"));
    const canonicalExpectedPath = existsSync(expectedPath)
      ? path.resolve(realpathSync(expectedPath))
      : path.resolve(expectedPath);
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === canonicalExpectedPath) continue;

    mismatches.push({
      workspaceDir,
      packageName,
      expectedPath: canonicalExpectedPath,
      actualPath,
    });
  }

  return mismatches;
}

export async function ensureAllWorkspaceLinksCurrent(rootDir = repoRoot) {
  const workspacePackagePaths = discoverWorkspacePackagePaths(rootDir);
  const workspaceDirs = Array.from(
    new Set(
      Array.from(workspacePackagePaths.values())
        .map((packagePath) => path.relative(rootDir, packagePath))
        .filter((workspaceDir) => workspaceDir.length > 0),
    ),
  ).sort();

  for (const workspaceDir of workspaceDirs) {
    const mismatches = findWorkspaceLinkMismatches(workspaceDir, workspacePackagePaths, rootDir);
    if (mismatches.length === 0) continue;

    console.log(`[paperclip] detected stale workspace package links for ${workspaceDir}; relinking dependencies...`);
    for (const mismatch of mismatches) {
      console.log(
        `[paperclip]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}`,
      );
    }

    for (const mismatch of mismatches) {
      const linkPath = path.join(rootDir, mismatch.workspaceDir, "node_modules", ...mismatch.packageName.split("/"));
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.rm(linkPath, { recursive: true, force: true });
      await fs.symlink(mismatch.expectedPath, linkPath);
    }

    const remainingMismatches = findWorkspaceLinkMismatches(workspaceDir, workspacePackagePaths, rootDir);
    if (remainingMismatches.length > 0) {
      throw new Error(
        `Workspace relink did not repair all ${workspaceDir} package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
      );
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await ensureAllWorkspaceLinksCurrent();
}
