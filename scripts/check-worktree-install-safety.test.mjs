import assert from "node:assert/strict";
import test from "node:test";

import {
  findSharedWorktreeNodeModulesRisk,
  formatSharedWorktreeNodeModulesRisk,
} from "./check-worktree-install-safety.mjs";

test("returns null for the primary checkout", () => {
  const risk = findSharedWorktreeNodeModulesRisk({
    repoRoot: "/repo",
    gitCommonDir: ".git",
    nodeModulesPath: "/repo/node_modules",
    nodeModulesRealPath: "/repo/node_modules",
  });

  assert.equal(risk, null);
});

test("returns null for a worktree with isolated node_modules", () => {
  const risk = findSharedWorktreeNodeModulesRisk({
    repoRoot: "/repo-wt",
    gitCommonDir: "/repo/.git",
    nodeModulesPath: "/repo-wt/node_modules",
    nodeModulesRealPath: "/repo-wt/node_modules",
  });

  assert.equal(risk, null);
});

test("detects a worktree whose root node_modules resolves to another checkout", () => {
  const risk = findSharedWorktreeNodeModulesRisk({
    repoRoot: "/repo-wt",
    gitCommonDir: "/repo/.git",
    nodeModulesPath: "/repo-wt/node_modules",
    nodeModulesRealPath: "/repo/node_modules",
  });

  assert.deepEqual(risk, {
    repoRoot: "/repo-wt",
    gitCommonDir: "/repo/.git",
    nodeModulesPath: "/repo-wt/node_modules",
    nodeModulesRealPath: "/repo/node_modules",
  });
  assert.match(formatSharedWorktreeNodeModulesRisk(risk), /Refusing `pnpm install`/);
  assert.match(formatSharedWorktreeNodeModulesRisk(risk), /PAPERCLIP_ALLOW_SHARED_WORKTREE_INSTALL=1/);
});
