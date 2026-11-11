import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ensureGitWorktreeBranchCoherent } from "../services/workspace-runtime.ts";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function readGit(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function commitFile(cwd: string, name: string, message: string) {
  await fs.writeFile(path.join(cwd, name), `${message}\n`, "utf8");
  await runGit(cwd, ["add", name]);
  await runGit(cwd, ["commit", "-m", message]);
  return readGit(cwd, ["rev-parse", "HEAD"]);
}

async function createRepo() {
  const repoRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-clean-restore-repo-")),
  );
  await runGit(repoRoot, ["init", "--initial-branch", "main"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  return repoRoot;
}

async function createWorktreeOnRecordedBranch(expectedBranch: string) {
  const repoRoot = await createRepo();
  const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(repoRoot, ["worktree", "add", "-b", expectedBranch, worktreePath, "main"]);
  const expectedHead = await commitFile(worktreePath, "recorded.txt", "Recorded branch work");
  return { repoRoot, worktreePath, expectedHead };
}

async function currentBranch(worktreePath: string) {
  return readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null);
}

function ensureCoherent(input: { repoRoot: string; worktreePath: string; expectedBranch: string }) {
  return ensureGitWorktreeBranchCoherent({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranch,
    sourceIssue: { id: "issue-clean-restore", identifier: "PAP-1", title: "Clean restore" },
    enableWorkspaceBranchReconcileForward: false,
    enableWorkspaceDirtyQuarantineRepair: false,
    enableWorkspaceCleanRestore: true,
  });
}

describe("clean worktree branch restore", () => {
  it("refuses a detached HEAD even when another ref reaches the commit", async () => {
    const expectedBranch = "task-recorded-detached-reachable";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    const mainHead = await commitFile(repoRoot, "main-work.txt", "Main work");
    await runGit(worktreePath, ["checkout", "--detach", mainHead]);

    await expect(ensureCoherent({ repoRoot, worktreePath, expectedBranch })).rejects.toMatchObject({
      code: "workspace_validation_failed",
    });
    expect(await currentBranch(worktreePath)).toBeNull();
    expect(await readGit(worktreePath, ["rev-parse", "HEAD"])).toBe(mainHead);
  }, 20_000);

  it("restores the recorded branch from a diverged local branch and keeps its ref", async () => {
    const expectedBranch = "task-recorded-diverged";
    const driftBranch = "drift-diverged";
    const { repoRoot, worktreePath, expectedHead } =
      await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", driftBranch, "main"]);
    const driftHead = await commitFile(worktreePath, "drift.txt", "Drift work");

    const result = await ensureCoherent({ repoRoot, worktreePath, expectedBranch });

    expect(result.branchName).toBe(expectedBranch);
    expect(await currentBranch(worktreePath)).toBe(expectedBranch);
    expect(await readGit(worktreePath, ["rev-parse", "HEAD"])).toBe(expectedHead);
    expect(await readGit(repoRoot, ["rev-parse", driftBranch])).toBe(driftHead);
  }, 20_000);

  it("restores the recorded branch from a local branch behind it", async () => {
    const expectedBranch = "task-recorded-behind";
    const driftBranch = "drift-behind";
    const { repoRoot, worktreePath, expectedHead } =
      await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", driftBranch, "main"]);

    const result = await ensureCoherent({ repoRoot, worktreePath, expectedBranch });

    expect(result.branchName).toBe(expectedBranch);
    expect(await currentBranch(worktreePath)).toBe(expectedBranch);
    expect(await readGit(worktreePath, ["rev-parse", "HEAD"])).toBe(expectedHead);
  }, 20_000);

  it("refuses a detached HEAD that no ref reaches", async () => {
    const expectedBranch = "task-recorded-detached-unreachable";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(repoRoot, ["checkout", "-b", "temporary-orphan"]);
    const orphanHead = await commitFile(repoRoot, "orphan.txt", "Orphan work");
    await runGit(repoRoot, ["checkout", "main"]);
    await runGit(repoRoot, ["branch", "-D", "temporary-orphan"]);
    await runGit(worktreePath, ["checkout", "--detach", orphanHead]);

    await expect(ensureCoherent({ repoRoot, worktreePath, expectedBranch })).rejects.toMatchObject({
      code: "workspace_validation_failed",
    });
    expect(await currentBranch(worktreePath)).toBeNull();
    expect(await readGit(worktreePath, ["rev-parse", "HEAD"])).toBe(orphanHead);
  }, 20_000);

  it("refuses when the worktree is dirty", async () => {
    const expectedBranch = "task-recorded-dirty";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", "drift-dirty", "main"]);
    await fs.writeFile(path.join(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    await expect(ensureCoherent({ repoRoot, worktreePath, expectedBranch })).rejects.toMatchObject({
      code: "workspace_validation_failed",
    });
    expect(await currentBranch(worktreePath)).toBe("drift-dirty");
  }, 20_000);

  it("refuses while a git operation is in progress", async () => {
    const expectedBranch = "task-recorded-in-progress";
    const { repoRoot, worktreePath, expectedHead } =
      await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", "drift-in-progress", "main"]);
    const gitDir = await readGit(worktreePath, ["rev-parse", "--git-dir"]);
    await fs.writeFile(path.resolve(worktreePath, gitDir, "MERGE_HEAD"), `${expectedHead}\n`, "utf8");

    await expect(ensureCoherent({ repoRoot, worktreePath, expectedBranch })).rejects.toMatchObject({
      code: "workspace_validation_failed",
    });
    expect(await currentBranch(worktreePath)).toBe("drift-in-progress");
  }, 20_000);

  it("refuses when the recorded branch is checked out in another worktree", async () => {
    const expectedBranch = "task-recorded-elsewhere";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", "drift-elsewhere", "main"]);
    await runGit(repoRoot, ["checkout", expectedBranch]);

    await expect(ensureCoherent({ repoRoot, worktreePath, expectedBranch })).rejects.toMatchObject({
      code: "workspace_validation_failed",
    });
    expect(await currentBranch(worktreePath)).toBe("drift-elsewhere");
  }, 20_000);

  it("refuses when the recorded branch no longer exists", async () => {
    const expectedBranch = "task-recorded-missing";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", "drift-missing", "main"]);
    await runGit(repoRoot, ["branch", "-D", expectedBranch]);

    await expect(ensureCoherent({ repoRoot, worktreePath, expectedBranch })).rejects.toMatchObject({
      code: "workspace_validation_failed",
    });
    expect(await currentBranch(worktreePath)).toBe("drift-missing");
  }, 20_000);

  it("refuses clean drift when clean restore is disabled", async () => {
    const expectedBranch = "task-recorded-disabled";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", "drift-disabled", "main"]);

    await expect(
      ensureGitWorktreeBranchCoherent({
        repoRoot,
        worktreePath,
        expectedBranchName: expectedBranch,
        sourceIssue: { id: "issue-clean-restore", identifier: "PAP-1", title: "Clean restore" },
        enableWorkspaceBranchReconcileForward: false,
        enableWorkspaceDirtyQuarantineRepair: false,
        enableWorkspaceCleanRestore: false,
      }),
    ).rejects.toMatchObject({ code: "workspace_validation_failed" });
    expect(await currentBranch(worktreePath)).toBe("drift-disabled");
  }, 20_000);

  it("refuses when a file ignored on the drift branch is tracked on the recorded branch", async () => {
    const expectedBranch = "task-recorded-ignored-collision";
    const driftBranch = "drift-ignored-collision";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await commitFile(worktreePath, "collision.txt", "Recorded collision bytes");
    await runGit(worktreePath, ["checkout", "-b", driftBranch, "main"]);
    await fs.writeFile(path.join(worktreePath, ".gitignore"), "collision.txt\n", "utf8");
    await runGit(worktreePath, ["add", ".gitignore"]);
    await runGit(worktreePath, ["commit", "-m", "Ignore collision path"]);
    const collisionPath = path.join(worktreePath, "collision.txt");
    await fs.writeFile(collisionPath, "local ignored sentinel\n", "utf8");

    await expect(ensureCoherent({ repoRoot, worktreePath, expectedBranch })).rejects.toMatchObject({
      code: "workspace_validation_failed",
    });
    expect(await currentBranch(worktreePath)).toBe(driftBranch);
    expect(await fs.readFile(collisionPath, "utf8")).toBe("local ignored sentinel\n");
  }, 20_000);

  it("returns the restore warning and records the finalize phase on the finalize path", async () => {
    const expectedBranch = "task-recorded-finalize-phase";
    const driftBranch = "drift-finalize-phase";
    const { repoRoot, worktreePath, expectedHead } =
      await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", driftBranch, "main"]);

    const recordedPhases: string[] = [];
    const recorder = {
      attachExecutionWorkspaceId: async () => {},
      recordOperation: async (input: {
        phase: string;
        run: (reportProgress: () => Promise<void>) => Promise<object>;
      }) => {
        recordedPhases.push(input.phase);
        await input.run(async () => {});
        return {};
      },
    } as unknown as WorkspaceOperationRecorder;

    const result = await ensureGitWorktreeBranchCoherent({
      repoRoot,
      worktreePath,
      expectedBranchName: expectedBranch,
      sourceIssue: { id: "issue-clean-restore", identifier: "PAP-1", title: "Clean restore" },
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
      enableWorkspaceCleanRestore: true,
      reconcileOperationPhase: "workspace_finalize",
      recorder,
    });

    expect(result.branchName).toBe(expectedBranch);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(recordedPhases).toContain("workspace_finalize");
    expect(await currentBranch(worktreePath)).toBe(expectedBranch);
    expect(await readGit(worktreePath, ["rev-parse", "HEAD"])).toBe(expectedHead);
  }, 20_000);
});
