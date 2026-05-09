#!/usr/bin/env -S node --import tsx
import fs from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./dev-service-profile.ts";

type WorkspaceLinkMismatch = {
  workspaceDir: string;
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  visit(path.join(rootDir, "packages"));
  visit(path.join(rootDir, "server"));
  visit(path.join(rootDir, "ui"));
  visit(path.join(rootDir, "cli"));

  return packagePaths;
}

const workspacePackagePaths = discoverWorkspacePackagePaths(repoRoot);
const workspaceDirs = Array.from(
  new Set(
    Array.from(workspacePackagePaths.values())
      .map((packagePath) => path.relative(repoRoot, packagePath))
      .filter((workspaceDir) => workspaceDir.length > 0),
  ),
).sort();

function findWorkspaceLinkMismatches(workspaceDir: string): WorkspaceLinkMismatch[] {
  const nodeModulesDir = path.join(repoRoot, workspaceDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    return [];
  }

  const packageJson = readJsonFile(path.join(repoRoot, workspaceDir, "package.json"));
  const dependencies = {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;

    const linkPath = path.join(repoRoot, workspaceDir, "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === path.resolve(expectedPath)) continue;

    mismatches.push({
      workspaceDir,
      packageName,
      expectedPath: path.resolve(expectedPath),
      actualPath,
    });
  }

  return mismatches;
}

async function ensureWorkspaceLinksCurrent(workspaceDir: string) {
  const mismatches = findWorkspaceLinkMismatches(workspaceDir);
  if (mismatches.length === 0) return;

  console.log(`[paperclip] detected stale workspace package links for ${workspaceDir}; relinking dependencies...`);
  for (const mismatch of mismatches) {
    console.log(
      `[paperclip]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}`,
    );
  }

  for (const mismatch of mismatches) {
    const linkPath = path.join(repoRoot, mismatch.workspaceDir, "node_modules", ...mismatch.packageName.split("/"));
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(mismatch.expectedPath, linkPath);
  }

  const remainingMismatches = findWorkspaceLinkMismatches(workspaceDir);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all ${workspaceDir} package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

for (const workspaceDir of workspaceDirs) {
  await ensureWorkspaceLinksCurrent(workspaceDir);
}
