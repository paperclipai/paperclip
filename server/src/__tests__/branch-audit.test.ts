import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBranchAudit,
  deleteMergedLocalBranches,
  pruneGitWorktrees,
} from "../services/branch-audit.ts";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-branch-audit-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "PrivateClip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Branch audit\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "master"]);
  return repoRoot;
}

async function commitFile(cwd: string, filename: string, body: string, message: string) {
  await fs.writeFile(path.join(cwd, filename), body, "utf8");
  await runGit(cwd, ["add", filename]);
  await runGit(cwd, ["commit", "-m", message]);
}

describe("branch audit", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("reports merged branches, unique commits, and active worktrees", async () => {
    const repoRoot = await createTempRepo();
    cleanupDirs.add(repoRoot);

    await runGit(repoRoot, ["checkout", "-b", "merged-branch"]);
    await commitFile(repoRoot, "merged.txt", "merged\n", "Merged branch commit");
    await runGit(repoRoot, ["checkout", "master"]);
    await runGit(repoRoot, ["merge", "--no-ff", "--no-edit", "merged-branch"]);

    await runGit(repoRoot, ["checkout", "-b", "active-worktree"]);
    await runGit(repoRoot, ["checkout", "master"]);
    const activeWorktreePath = path.join(path.dirname(repoRoot), "paperclip-active-worktree");
    cleanupDirs.add(activeWorktreePath);
    await runGit(repoRoot, ["worktree", "add", activeWorktreePath, "active-worktree"]);
    await commitFile(activeWorktreePath, "active.txt", "active\n", "Active worktree commit");
    const resolvedActiveWorktreePath = await fs.realpath(activeWorktreePath);

    const report = await collectBranchAudit(repoRoot, { baseRef: "master" });

    const mergedBranch = report.branches.find((branch) => branch.name === "merged-branch");
    expect(mergedBranch).toMatchObject({
      mergedIntoBase: true,
      uniqueCommitCount: 0,
      worktreePath: null,
    });

    const activeBranch = report.branches.find((branch) => branch.name === "active-worktree");
    expect(activeBranch).toMatchObject({
      mergedIntoBase: false,
      uniqueCommitCount: 1,
      worktreePath: resolvedActiveWorktreePath,
      worktreeState: "active",
    });
  });

  it("prunes stale worktrees without touching active worktrees", async () => {
    const repoRoot = await createTempRepo();
    cleanupDirs.add(repoRoot);

    await runGit(repoRoot, ["checkout", "-b", "live-worktree"]);
    await runGit(repoRoot, ["checkout", "master"]);
    const liveWorktreePath = path.join(path.dirname(repoRoot), "paperclip-live-worktree");
    cleanupDirs.add(liveWorktreePath);
    await runGit(repoRoot, ["worktree", "add", liveWorktreePath, "live-worktree"]);
    const resolvedLiveWorktreePath = await fs.realpath(liveWorktreePath);

    await runGit(repoRoot, ["checkout", "-b", "stale-worktree"]);
    await runGit(repoRoot, ["checkout", "master"]);
    const staleWorktreePath = path.join(path.dirname(repoRoot), "paperclip-stale-worktree");
    cleanupDirs.add(staleWorktreePath);
    await runGit(repoRoot, ["worktree", "add", staleWorktreePath, "stale-worktree"]);
    await fs.rm(staleWorktreePath, { recursive: true, force: true });

    await pruneGitWorktrees(repoRoot);
    const report = await collectBranchAudit(repoRoot, { baseRef: "master" });

    expect(report.branches.find((branch) => branch.name === "live-worktree")).toMatchObject({
      worktreePath: resolvedLiveWorktreePath,
      worktreeState: "active",
    });
    expect(report.branches.find((branch) => branch.name === "stale-worktree")).toMatchObject({
      worktreePath: null,
      worktreeState: null,
    });
  });

  it("deletes merged branches while preserving branches attached to active worktrees", async () => {
    const repoRoot = await createTempRepo();
    cleanupDirs.add(repoRoot);

    await runGit(repoRoot, ["checkout", "-b", "merged-clean"]);
    await commitFile(repoRoot, "merged-clean.txt", "merged\n", "Merged clean branch");
    await runGit(repoRoot, ["checkout", "master"]);
    await runGit(repoRoot, ["merge", "--no-ff", "--no-edit", "merged-clean"]);

    await runGit(repoRoot, ["checkout", "-b", "attached-branch"]);
    await runGit(repoRoot, ["checkout", "master"]);
    const attachedWorktreePath = path.join(path.dirname(repoRoot), "paperclip-attached-worktree");
    cleanupDirs.add(attachedWorktreePath);
    await runGit(repoRoot, ["worktree", "add", attachedWorktreePath, "attached-branch"]);

    const result = await deleteMergedLocalBranches(repoRoot, {
      baseRef: "master",
      preserveAttachedWorktrees: true,
    });

    expect(result.deleted).toContain("merged-clean");
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ branch: "attached-branch", reason: "active worktree" }),
    ]));

    const report = await collectBranchAudit(repoRoot, { baseRef: "master" });
    expect(report.branches.some((branch) => branch.name === "merged-clean")).toBe(false);
    expect(report.branches.some((branch) => branch.name === "attached-branch")).toBe(true);
  }, 15_000);
});
