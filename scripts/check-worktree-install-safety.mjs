#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function normalizePath(value) {
  return path.resolve(value);
}

function isPathInside(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveGitCommonDir(repoRoot, gitCommonDir) {
  if (path.isAbsolute(gitCommonDir)) {
    return normalizePath(gitCommonDir);
  }
  return normalizePath(path.join(repoRoot, gitCommonDir));
}

export function findSharedWorktreeNodeModulesRisk({
  repoRoot,
  gitCommonDir,
  nodeModulesPath,
  nodeModulesRealPath,
}) {
  const normalizedRepoRoot = normalizePath(repoRoot);
  const normalizedGitCommonDir = resolveGitCommonDir(normalizedRepoRoot, gitCommonDir);
  const primaryGitDir = normalizePath(path.join(normalizedRepoRoot, ".git"));

  if (normalizedGitCommonDir === primaryGitDir) {
    return null;
  }

  const normalizedNodeModulesRealPath = normalizePath(nodeModulesRealPath);
  if (isPathInside(normalizedRepoRoot, normalizedNodeModulesRealPath)) {
    return null;
  }

  return {
    repoRoot: normalizedRepoRoot,
    gitCommonDir: normalizedGitCommonDir,
    nodeModulesPath: normalizePath(nodeModulesPath),
    nodeModulesRealPath: normalizedNodeModulesRealPath,
  };
}

function readGitValue(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function getSharedWorktreeNodeModulesRisk(cwd = process.cwd()) {
  const repoRoot = readGitValue(["rev-parse", "--show-toplevel"], cwd);
  const gitCommonDir = readGitValue(["rev-parse", "--git-common-dir"], cwd);
  const nodeModulesPath = path.join(repoRoot, "node_modules");
  if (!existsSync(nodeModulesPath)) {
    return null;
  }

  return findSharedWorktreeNodeModulesRisk({
    repoRoot,
    gitCommonDir,
    nodeModulesPath,
    nodeModulesRealPath: realpathSync(nodeModulesPath),
  });
}

export function formatSharedWorktreeNodeModulesRisk(risk) {
  return [
    "Refusing `pnpm install` from a git worktree that still shares root `node_modules` with another checkout.",
    `Worktree root: ${risk.repoRoot}`,
    `Shared git dir: ${risk.gitCommonDir}`,
    `node_modules path: ${risk.nodeModulesPath}`,
    `node_modules resolves to: ${risk.nodeModulesRealPath}`,
    "",
    "This layout will overwrite the other checkout's pnpm metadata (`node_modules/.modules.yaml`) and can make the served tree uninstallable.",
    "Use the isolated Paperclip worktree provisioning flow first so this worktree gets its own `node_modules`, then rerun the install.",
    "Override only if you intentionally accept that cross-checkout damage: `PAPERCLIP_ALLOW_SHARED_WORKTREE_INSTALL=1 pnpm install`.",
  ].join("\n");
}

function main() {
  if (process.env.PAPERCLIP_ALLOW_SHARED_WORKTREE_INSTALL === "1") {
    return;
  }

  const risk = getSharedWorktreeNodeModulesRisk();
  if (!risk) {
    return;
  }

  console.error(formatSharedWorktreeNodeModulesRisk(risk));
  process.exitCode = 1;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main();
}
