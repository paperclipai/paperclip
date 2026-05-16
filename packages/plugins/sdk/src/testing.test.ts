import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExecutionWorkspace, Issue, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "./testing.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-sdk-testing",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Plugin SDK Testing",
  description: "Test manifest for the SDK harness.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["issues.read", "issues.create", "issues.update"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

function buildExecutionWorkspace(
  input: Partial<ExecutionWorkspace> & Pick<ExecutionWorkspace, "id" | "companyId" | "projectId">,
): ExecutionWorkspace {
  const now = new Date();
  const { id, companyId, projectId, ...rest } = input;
  return {
    id,
    companyId,
    projectId,
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Implementation workspace",
    status: "active",
    cwd: "/tmp/plugin-sdk-testing",
    repoUrl: "https://github.com/paperclipai/paperclip",
    baseRef: "main",
    branchName: "feature/plugin-sdk-testing",
    providerType: "git_worktree",
    providerRef: "/tmp/plugin-sdk-testing",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [],
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

function buildIssue(input: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  const { id, companyId, title, ...rest } = input;
  return {
    id,
    companyId,
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: "plugin:paperclipai.plugin-sdk-testing",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

describe("createTestHarness issues helpers", () => {
  it("captures execution provenance during same-code-change issue creation", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const harness = createTestHarness({ manifest });

    harness.seed({
      issues: [
        buildIssue({
          id: sourceIssueId,
          companyId,
          title: "Source issue",
          projectWorkspaceId: "project-workspace-1",
          executionWorkspaceId,
          executionWorkspacePreference: "reuse_existing",
          executionWorkspaceSettings: { mode: "isolated_workspace" },
          currentExecutionWorkspace: buildExecutionWorkspace({
            id: executionWorkspaceId,
            companyId,
            projectId: "project-1",
            branchName: "feature/source",
            baseRef: "main",
          }),
        }),
      ],
    });

    const created = await harness.ctx.issues.create({
      companyId,
      projectId: "project-1",
      title: "Review issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
      executionProvenance: { handoffRole: "review" },
    });

    expect(created.projectWorkspaceId).toBe("project-workspace-1");
    expect(created.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(created.executionWorkspacePreference).toBe("reuse_existing");
    expect(created.executionWorkspaceSettings).toEqual({ mode: "isolated_workspace" });
    expect(created.executionProvenance).toMatchObject({
      handoffRole: "review",
      sourceIssueId,
      sourceExecutionWorkspaceId: executionWorkspaceId,
      branchName: "feature/source",
      baseRef: "main",
    });
    expect(typeof created.executionProvenance?.capturedAt).toBe("string");
  });

  it("captures execution provenance during same-code-change issue updates", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    const reviewIssueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const harness = createTestHarness({ manifest });

    harness.seed({
      issues: [
        buildIssue({
          id: sourceIssueId,
          companyId,
          title: "Source issue",
          projectWorkspaceId: "project-workspace-1",
          executionWorkspaceId,
          executionWorkspacePreference: "reuse_existing",
          executionWorkspaceSettings: { mode: "isolated_workspace" },
          currentExecutionWorkspace: buildExecutionWorkspace({
            id: executionWorkspaceId,
            companyId,
            projectId: "project-1",
            branchName: "feature/source",
            baseRef: "main",
          }),
        }),
        buildIssue({
          id: reviewIssueId,
          companyId,
          title: "Review issue",
        }),
      ],
    });

    const updated = await harness.ctx.issues.update(reviewIssueId, {
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
      executionProvenance: { handoffRole: "qa" },
    }, companyId);

    expect(updated.projectWorkspaceId).toBe("project-workspace-1");
    expect(updated.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(updated.executionWorkspacePreference).toBe("reuse_existing");
    expect(updated.executionWorkspaceSettings).toEqual({ mode: "isolated_workspace" });
    expect(updated.executionProvenance).toMatchObject({
      handoffRole: "qa",
      sourceIssueId,
      sourceExecutionWorkspaceId: executionWorkspaceId,
      branchName: "feature/source",
      baseRef: "main",
    });
    expect(typeof updated.executionProvenance?.capturedAt).toBe("string");
  });
});
