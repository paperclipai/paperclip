import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { acquireGitWorktreeCleanupLock } from "../services/workspace-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function packedSlashBranchWorktree() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "worktree-cleanup-lock-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(repo);
  await exec("git", ["init", repo]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
  await exec("git", ["-C", repo, "branch", "fix/demo"]);
  await exec("git", ["-C", repo, "pack-refs", "--all"]);
  const refsDir = path.join(repo, ".git", "refs", "heads", "fix");
  await fs.rm(refsDir, { recursive: true, force: true });
  await exec("git", ["-C", repo, "worktree", "add", worktree, "fix/demo"]);
  return { repo, worktree, refsDir };
}

describe("acquireGitWorktreeCleanupLock", () => {
  it("locks a packed slash-named branch whose ref folder is missing and removes the folder on release", async () => {
    const { repo, worktree, refsDir } = await packedSlashBranchWorktree();
    expect(existsSync(refsDir)).toBe(false);

    const lock = await acquireGitWorktreeCleanupLock(worktree);
    expect(existsSync(path.join(refsDir, "demo.lock"))).toBe(true);

    await lock.releaseBranchRefLock();
    expect(existsSync(refsDir)).toBe(false);
    await lock.release();

    await expect(exec("git", ["-C", repo, "rev-parse", "--verify", "refs/heads/fix/demo"])).resolves.toBeTruthy();
  });

  it("keeps a ref folder that gained other entries while the lock was held", async () => {
    const { worktree, refsDir } = await packedSlashBranchWorktree();

    const lock = await acquireGitWorktreeCleanupLock(worktree);
    await fs.writeFile(path.join(refsDir, "other"), "placeholder\n");
    await lock.release();

    expect(existsSync(path.join(refsDir, "demo.lock"))).toBe(false);
    expect(existsSync(path.join(refsDir, "other"))).toBe(true);
  });
});
