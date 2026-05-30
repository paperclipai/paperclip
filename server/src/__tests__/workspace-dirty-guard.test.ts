import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceCleanForBranchSwitch,
  inspectWorkspaceCleanliness,
  WorkspaceDirtyError,
} from "../services/workspace-dirty-guard.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createCleanRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dirty-guard-"));
  await git(repoRoot, ["init", "--initial-branch=main"]);
  await git(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "Initial commit"]);
  return repoRoot;
}

async function resolveGitDir(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot });
  const value = stdout.trim();
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

describe("inspectWorkspaceCleanliness", () => {
  it("reports clean on an untouched checkout (T4)", async () => {
    const repoRoot = await createCleanRepo();
    const report = await inspectWorkspaceCleanliness({ cwd: repoRoot });
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("reports modified-tree porcelain output (T5)", async () => {
    const repoRoot = await createCleanRepo();
    await fs.writeFile(path.join(repoRoot, "README.md"), "modified\n", "utf8");
    const report = await inspectWorkspaceCleanliness({ cwd: repoRoot });
    expect(report.clean).toBe(false);
    expect(report.findings.some((f) => f.reason === "porcelain_modified")).toBe(true);
  });

  it("reports untracked files (T5)", async () => {
    const repoRoot = await createCleanRepo();
    await fs.writeFile(path.join(repoRoot, "scratch.txt"), "wip\n", "utf8");
    const report = await inspectWorkspaceCleanliness({ cwd: repoRoot });
    expect(report.clean).toBe(false);
    expect(report.findings.some((f) => f.reason === "porcelain_untracked")).toBe(true);
  });

  it("detects in-progress merge from .git/MERGE_HEAD (T6)", async () => {
    const repoRoot = await createCleanRepo();
    const gitDir = await resolveGitDir(repoRoot);
    await fs.writeFile(path.join(gitDir, "MERGE_HEAD"), "deadbeef\n", "utf8");
    const report = await inspectWorkspaceCleanliness({ cwd: repoRoot });
    expect(report.clean).toBe(false);
    expect(report.findings.some((f) => f.reason === "merge_in_progress")).toBe(true);
  });

  it("detects in-progress rebase from .git/REBASE_HEAD (T7)", async () => {
    const repoRoot = await createCleanRepo();
    const gitDir = await resolveGitDir(repoRoot);
    await fs.writeFile(path.join(gitDir, "REBASE_HEAD"), "deadbeef\n", "utf8");
    const report = await inspectWorkspaceCleanliness({ cwd: repoRoot });
    expect(report.clean).toBe(false);
    expect(report.findings.some((f) => f.reason === "rebase_in_progress")).toBe(true);
  });

  it("detects each remaining in-progress git state marker (T7)", async () => {
    const repoRoot = await createCleanRepo();
    const gitDir = await resolveGitDir(repoRoot);
    await fs.writeFile(path.join(gitDir, "CHERRY_PICK_HEAD"), "x\n", "utf8");
    await fs.writeFile(path.join(gitDir, "REVERT_HEAD"), "y\n", "utf8");
    await fs.writeFile(path.join(gitDir, "AUTO_MERGE"), "z\n", "utf8");
    const report = await inspectWorkspaceCleanliness({ cwd: repoRoot });
    expect(report.clean).toBe(false);
    const reasons = new Set(report.findings.map((f) => f.reason));
    expect(reasons.has("cherry_pick_in_progress")).toBe(true);
    expect(reasons.has("revert_in_progress")).toBe(true);
    expect(reasons.has("auto_merge_in_progress")).toBe(true);
  });

  it("reports the current branch via porcelain v2 (--branch)", async () => {
    const repoRoot = await createCleanRepo();
    const report = await inspectWorkspaceCleanliness({ cwd: repoRoot });
    expect(report.currentBranch).toBe("main");
  });
});

describe("assertWorkspaceCleanForBranchSwitch", () => {
  it("returns the report on a clean tree", async () => {
    const repoRoot = await createCleanRepo();
    const report = await assertWorkspaceCleanForBranchSwitch({ cwd: repoRoot });
    expect(report.clean).toBe(true);
  });

  it("throws WorkspaceDirtyError on a dirty tree and never tries to stash/reset", async () => {
    const repoRoot = await createCleanRepo();
    await fs.writeFile(path.join(repoRoot, "README.md"), "modified\n", "utf8");
    try {
      await assertWorkspaceCleanForBranchSwitch({
        cwd: repoRoot,
        owningExecutionWorkspaceId: "ws-123",
      });
      throw new Error("expected dirty-guard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceDirtyError);
      const dirty = error as WorkspaceDirtyError;
      expect(dirty.code).toBe("workspace_dirty");
      expect(dirty.owningExecutionWorkspaceId).toBe("ws-123");
      expect(dirty.findings.length).toBeGreaterThan(0);
    }
    // Sanity: the modified file is still modified — the guard did not
    // silently stash/reset to "fix" the dirty state.
    const after = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
    expect(after).toBe("modified\n");
  });
});
