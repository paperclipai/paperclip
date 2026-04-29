import { describe, expect, it } from "vitest";
import type { ExecutionWorkspace, Issue } from "@paperclipai/shared";
import { buildSubIssueDefaults, buildSubIssueDefaultsForViewer } from "./subIssueDefaults";

function makeExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: null,
    status: "active",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Parent workspace",
    cwd: "/tmp/workspace-1",
    repoUrl: null,
    baseRef: null,
    branchName: "feature/pap-1",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    openedAt: new Date("2026-04-07T00:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    lastUsedAt: new Date("2026-04-07T00:00:00.000Z"),
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    goalId: "goal-1",
    parentId: null,
    title: "Parent issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: "shared_workspace",
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildSubIssueDefaults", () => {
  it("inherits the parent agent assignee and workspace context", () => {
    const defaults = buildSubIssueDefaults(
      makeIssue({
        assigneeAgentId: "agent-1",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: makeExecutionWorkspace(),
      }),
    );

    expect(defaults).toEqual({
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-1",
      goalId: "goal-1",
      executionWorkspaceId: "workspace-1",
      executionWorkspaceMode: "reuse_existing",
      parentExecutionWorkspaceLabel: "Parent workspace",
      assigneeAgentId: "agent-1",
    });
  });

  it("inherits a user assignee when the parent is assigned to a user", () => {
    const defaults = buildSubIssueDefaults(
      makeIssue({
        assigneeUserId: "user-1",
      }),
    );

    expect(defaults).toEqual({
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-1",
      goalId: "goal-1",
      executionWorkspaceMode: "shared_workspace",
      assigneeUserId: "user-1",
    });
  });

  it("leaves the sub-issue unassigned when the parent assignee is the current user", () => {
    const defaults = buildSubIssueDefaultsForViewer(
      makeIssue({
        assigneeUserId: "user-1",
      }),
      "user-1",
    );

    expect(defaults).toEqual({
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-1",
      goalId: "goal-1",
      executionWorkspaceMode: "shared_workspace",
    });
  });
});
