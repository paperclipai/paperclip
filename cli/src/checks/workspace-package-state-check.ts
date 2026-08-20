import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "./index.js";

export type WorkspacePackageStateIssue = {
  kind: "escaped_node_modules" | "escaped_virtual_store" | "dangling_dependency_link";
  path: string;
  target?: string;
};

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function findPaperclipWorkspaceRoot(startDir: string): string | null {
  let candidate = path.resolve(startDir);
  while (true) {
    const packageJsonPath = path.join(candidate, "package.json");
    if (fs.existsSync(packageJsonPath) && fs.existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
      const packageJson = readJsonFile(packageJsonPath);
      if (packageJson.name === "paperclip" && packageJson.private === true) return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

function readVirtualStoreDir(modulesYamlPath: string): string | null {
  if (!fs.existsSync(modulesYamlPath)) return null;
  const match = fs.readFileSync(modulesYamlPath, "utf8").match(/^virtualStoreDir:\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function discoverPackageDirs(rootDir: string): string[] {
  const packageDirs = new Set<string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules", "storybook-static"]);

  function visit(dirPath: string) {
    if (fs.existsSync(path.join(dirPath, "package.json"))) packageDirs.add(dirPath);
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  if (fs.existsSync(path.join(rootDir, "package.json"))) packageDirs.add(rootDir);
  for (const relativeRoot of ["packages", "server", "ui", "cli"]) {
    const candidate = path.join(rootDir, relativeRoot);
    if (fs.existsSync(candidate)) visit(candidate);
  }
  return [...packageDirs].sort();
}

function dependencyNames(packageDir: string): string[] {
  const packageJson = readJsonFile(path.join(packageDir, "package.json"));
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  return [...names];
}

export function inspectWorkspacePackageState(rootDir: string): WorkspacePackageStateIssue[] {
  const resolvedRoot = findPaperclipWorkspaceRoot(rootDir);
  if (!resolvedRoot) return [];

  const issues: WorkspacePackageStateIssue[] = [];
  const rootNodeModules = path.join(resolvedRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    const resolvedNodeModules = fs.realpathSync(rootNodeModules);
    if (!isPathInside(resolvedNodeModules, resolvedRoot)) {
      issues.push({ kind: "escaped_node_modules", path: rootNodeModules, target: resolvedNodeModules });
    }

    const virtualStoreDir = readVirtualStoreDir(path.join(resolvedNodeModules, ".modules.yaml"));
    if (virtualStoreDir) {
      const resolvedVirtualStore = path.resolve(resolvedNodeModules, virtualStoreDir);
      if (!isPathInside(resolvedVirtualStore, resolvedRoot)) {
        issues.push({
          kind: "escaped_virtual_store",
          path: path.join(resolvedNodeModules, ".modules.yaml"),
          target: resolvedVirtualStore,
        });
      }
    }
  }

  for (const packageDir of discoverPackageDirs(resolvedRoot)) {
    for (const dependencyName of dependencyNames(packageDir)) {
      const dependencyPath = path.join(packageDir, "node_modules", ...dependencyName.split("/"));
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(dependencyPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stats.isSymbolicLink()) continue;
      try {
        fs.realpathSync(dependencyPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        issues.push({ kind: "dangling_dependency_link", path: dependencyPath });
      }
    }
  }

  return issues;
}

export function workspacePackageStateCheck(rootDir = process.cwd()): CheckResult {
  const issues = inspectWorkspacePackageState(rootDir);
  if (issues.length === 0) {
    return {
      name: "Workspace package installation",
      status: "pass",
      message: "pnpm virtual store and direct dependency links are contained and resolvable",
    };
  }

  const escapedVirtualStore = issues.find((issue) => issue.kind === "escaped_virtual_store");
  const escapedNodeModules = issues.find((issue) => issue.kind === "escaped_node_modules");
  const danglingLinks = issues.filter((issue) => issue.kind === "dangling_dependency_link");
  const summaries = [
    escapedNodeModules ? `node_modules resolves outside the workspace (${escapedNodeModules.target})` : null,
    escapedVirtualStore ? `virtualStoreDir resolves outside the workspace (${escapedVirtualStore.target})` : null,
    danglingLinks.length > 0
      ? `${danglingLinks.length} dangling direct dependency symlink${danglingLinks.length === 1 ? "" : "s"}`
      : null,
  ].filter((value): value is string => Boolean(value));

  return {
    name: "Workspace package installation",
    status: "fail",
    message: summaries.join("; "),
    canRepair: false,
    repairHint:
      "From the real workspace root run `NODE_ENV=development pnpm install --prefer-offline --config.confirmModulesPurge=false`, then retry.",
  };
}
