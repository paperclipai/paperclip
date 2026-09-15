import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionWorkspace, IssueWorkProduct } from "@paperclipai/shared";
import { inspectGitCloseReadiness } from "./execution-workspaces.js";
import {
  evaluateIssueDoneDeliveryReadiness,
  hasExplicitNoMergeDisposition,
} from "./issue-delivery-readiness.js";

const execFileAsync = promisify(execFile);
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

function primary(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "Delivery PR",
    url: "https://github.com/paperclipai/paperclip/pull/1",
    status: "merged",
    reviewState: "approved",
    isPrimary: true,
    healthStatus: "healthy",
    summary: null,
    metadata: {
      deliveryEvidence: {
        reconciledAt: "2026-09-15T12:00:00.000Z",
        commitOnTarget: true,
        combinedRegressionChecks: [{ name: "server regression", status: "passed" }],
      },
    },
    createdByRunId: null,
    createdAt: new Date("2026-09-15T11:00:00.000Z"),
    updatedAt: new Date("2026-09-15T12:00:00.000Z"),
    ...overrides,
  };
}

describe("issue Done delivery readiness", () => {
  it("rejects an unmerged isolated workspace", () => {
    const result = evaluateIssueDoneDeliveryReadiness({
      primaryWorkProduct: primary(),
      hasIsolatedGitWorkspace: true,
      workspaceDeliveryState: "unmerged",
      workspaceGitInspectionSucceeded: true,
      workspaceGit: {
        repoRoot: "/repo",
        workspacePath: "/repo/worktree",
        branchName: "feature",
        baseRef: "main",
        hasDirtyTrackedFiles: false,
        hasUntrackedFiles: false,
        dirtyEntryCount: 0,
        untrackedEntryCount: 0,
        aheadCount: 1,
        behindCount: 0,
        isMergedIntoBase: false,
        isPatchEquivalentToBase: false,
        createdByRuntime: true,
      },
      issueStatus: "in_review",
      reviewPolicy: "not_creator",
    });
    expect(result.ready).toBe(false);
    expect(result.reasonCodes).toContain("delivered_commit_not_on_target");
  });

  it("rejects a ready_for_review primary work product", () => {
    const result = evaluateIssueDoneDeliveryReadiness({
      primaryWorkProduct: primary({ status: "ready_for_review" }),
      hasIsolatedGitWorkspace: false,
      issueStatus: "in_review",
      reviewPolicy: "not_creator",
    });
    expect(result.reasonCodes).toContain("primary_work_product_not_merged");
  });

  it("rejects missing independent review approval", () => {
    const result = evaluateIssueDoneDeliveryReadiness({
      primaryWorkProduct: primary({ reviewState: "none" }),
      hasIsolatedGitWorkspace: false,
      issueStatus: "in_review",
      reviewPolicy: "not_creator",
    });
    expect(result.reasonCodes).toContain("primary_work_product_review_not_approved");
  });

  it("rejects a code delivery without an independent review policy", () => {
    const result = evaluateIssueDoneDeliveryReadiness({
      primaryWorkProduct: primary(),
      hasIsolatedGitWorkspace: false,
      issueStatus: "in_review",
      reviewPolicy: "anyone",
    });
    expect(result.reasonCodes).toContain("independent_review_not_configured");
  });

  it("accepts a clean reconciled merged delivery", () => {
    const result = evaluateIssueDoneDeliveryReadiness({
      primaryWorkProduct: primary(),
      hasIsolatedGitWorkspace: true,
      workspaceDeliveryState: "merged_by_ancestry",
      workspaceGitInspectionSucceeded: true,
      workspaceGit: {
        repoRoot: "/repo",
        workspacePath: "/repo/worktree",
        branchName: "feature",
        baseRef: "main",
        hasDirtyTrackedFiles: false,
        hasUntrackedFiles: false,
        dirtyEntryCount: 0,
        untrackedEntryCount: 0,
        aheadCount: 0,
        behindCount: 0,
        isMergedIntoBase: true,
        isPatchEquivalentToBase: null,
        createdByRuntime: true,
      },
      issueStatus: "in_review",
      reviewPolicy: "not_creator",
    });
    expect(result).toMatchObject({ required: true, ready: true, disposition: "code", reasonCodes: [] });
  });

  it("recognizes an explicit analysis-only no-merge disposition", () => {
    const product = primary({
      type: "document",
      metadata: { deliveryDisposition: { kind: "no_merge", reason: "Analysis only; no repository changes." } },
    });
    expect(hasExplicitNoMergeDisposition(product)).toBe(true);
    expect(evaluateIssueDoneDeliveryReadiness({
      primaryWorkProduct: product,
      hasIsolatedGitWorkspace: false,
    })).toMatchObject({ required: false, ready: true, disposition: "no_merge" });
  });

  it("live-verifies patch-equivalent cherry-picks against the configured target", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-delivery-readiness-"));
    tempDirs.add(repo);
    await git(repo, "init");
    await git(repo, "config", "user.name", "Paperclip Test");
    await git(repo, "config", "user.email", "test@paperclip.local");
    await fs.writeFile(path.join(repo, "README.md"), "initial\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    await git(repo, "branch", "-M", "main");
    await git(repo, "checkout", "-b", "feature");
    await fs.writeFile(path.join(repo, "delivery.txt"), "delivered\n");
    await git(repo, "add", "delivery.txt");
    await git(repo, "commit", "-m", "delivery");
    const featureSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    await git(repo, "checkout", "main");
    await fs.writeFile(path.join(repo, "base.txt"), "target moved\n");
    await git(repo, "add", "base.txt");
    await git(repo, "commit", "-m", "move target");
    await git(repo, "cherry-pick", featureSha);
    await git(repo, "checkout", "feature");

    const inspection = await inspectGitCloseReadiness({
      id: "workspace-1",
      mode: "isolated_workspace",
      providerType: "git_worktree",
      providerRef: repo,
      cwd: repo,
      repoUrl: null,
      baseRef: "main",
      branchName: "feature",
      metadata: {},
    } as ExecutionWorkspace);

    expect(inspection.statusInspectionSucceeded).toBe(true);
    expect(inspection.git).toMatchObject({
      isMergedIntoBase: false,
      isPatchEquivalentToBase: true,
      hasDirtyTrackedFiles: false,
      hasUntrackedFiles: false,
    });
  });
});
