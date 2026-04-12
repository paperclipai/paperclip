import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionWorkspace, ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";
import { attemptQaPassAutoMerge, getIssueMergeStatus } from "../services/issue-merge.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function readGit(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return result.stdout.trim();
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-issue-merge-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "PrivateClip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "master"]);
  return repoRoot;
}

function makeWorkspace(overrides: Partial<ExecutionWorkspace>): ExecutionWorkspace {
  return {
    id: overrides.id ?? "workspace-1",
    companyId: overrides.companyId ?? "company-1",
    projectId: overrides.projectId ?? "project-1",
    projectWorkspaceId: overrides.projectWorkspaceId ?? "project-workspace-1",
    sourceIssueId: overrides.sourceIssueId ?? "issue-1",
    mode: overrides.mode ?? "isolated_workspace",
    strategyType: overrides.strategyType ?? "git_worktree",
    name: overrides.name ?? "Feature workspace",
    status: overrides.status ?? "active",
    cwd: overrides.cwd ?? null,
    repoUrl: overrides.repoUrl ?? null,
    baseRef: overrides.baseRef ?? "master",
    branchName: Object.prototype.hasOwnProperty.call(overrides, "branchName")
      ? (overrides.branchName ?? null)
      : "feature/qa-pass",
    providerType: overrides.providerType ?? "local_fs",
    providerRef: overrides.providerRef ?? null,
    derivedFromExecutionWorkspaceId: overrides.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: overrides.lastUsedAt ?? new Date("2026-04-10T12:00:00Z"),
    openedAt: overrides.openedAt ?? new Date("2026-04-10T11:00:00Z"),
    closedAt: overrides.closedAt ?? null,
    cleanupEligibleAt: overrides.cleanupEligibleAt ?? null,
    cleanupReason: overrides.cleanupReason ?? null,
    config: overrides.config ?? null,
    metadata: overrides.metadata ?? null,
    runtimeServices: overrides.runtimeServices ?? [],
    createdAt: overrides.createdAt ?? new Date("2026-04-10T11:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-10T11:30:00Z"),
  };
}

describe("issue merge service", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("reports a blocked status when merge-on-QA is enabled but branch metadata is missing", async () => {
    const status = await getIssueMergeStatus({
      issueStatus: "in_review",
      projectPolicy: {
        enabled: true,
        pullRequestPolicy: { mergeOnQaPass: true },
      } as ProjectExecutionWorkspacePolicy,
      executionWorkspace: makeWorkspace({
        cwd: "/repo",
        branchName: null,
      }),
      qaCanShip: true,
      lastIssueCommentStatus: "satisfied",
    });

    expect(status).toMatchObject({
      enabled: true,
      state: "blocked",
      reason: expect.stringContaining("branch"),
    });
  });

  it("merges the validated source branch into the configured target branch", async () => {
    const repoRoot = await createTempRepo();
    cleanupDirs.add(repoRoot);
    const resolvedRepoRoot = await fs.realpath(repoRoot);

    await runGit(repoRoot, ["checkout", "-b", "feature/qa-pass"]);
    await fs.writeFile(path.join(repoRoot, "feature.txt"), "validated\n", "utf8");
    await runGit(repoRoot, ["add", "feature.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Validated feature"]);

    const result = await attemptQaPassAutoMerge({
      projectPolicy: {
        enabled: true,
        branchPolicy: { targetBranch: "master" },
        pullRequestPolicy: { mergeOnQaPass: true, deleteBranchAfterMerge: false },
      } as ProjectExecutionWorkspacePolicy,
      executionWorkspace: makeWorkspace({
        cwd: repoRoot,
        branchName: "feature/qa-pass",
        baseRef: "master",
        providerType: "local_fs",
        metadata: {
          createdByRuntime: false,
        },
      }),
    });

    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") {
      throw new Error("expected merge");
    }

    expect(result.status).toMatchObject({
      enabled: true,
      state: "merged",
      targetBranch: "master",
      sourceBranch: "feature/qa-pass",
      repoRoot: resolvedRepoRoot,
      mergedCommit: expect.any(String),
    });

    const featureHistory = await readGit(repoRoot, ["log", "--oneline", "master", "--", "feature.txt"]);
    expect(featureHistory).toContain("Validated feature");
  });
});
