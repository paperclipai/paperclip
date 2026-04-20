import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { shouldShowBoardProjectChip } from "./issue-board";

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    companyId: "company-1",
    projectId: overrides.projectId ?? null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: overrides.title ?? "Issue",
    description: null,
    status: overrides.status ?? "todo",
    priority: overrides.priority ?? "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: overrides.identifier ?? null,
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
    createdAt: overrides.createdAt ?? new Date("2026-04-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-01T00:00:00Z"),
  };
}

describe("shouldShowBoardProjectChip", () => {
  it("returns false for project-scoped boards", () => {
    const issues = [makeIssue({ projectId: "project-1" })];
    expect(shouldShowBoardProjectChip(issues, "project-1")).toBe(false);
  });

  it("returns true when visible issues span multiple projects", () => {
    const issues = [
      makeIssue({ projectId: "project-1" }),
      makeIssue({ projectId: "project-2" }),
    ];

    expect(shouldShowBoardProjectChip(issues)).toBe(true);
  });

  it("returns false when visible issues only reference one project", () => {
    const issues = [
      makeIssue({ projectId: "project-1" }),
      makeIssue({ projectId: "project-1" }),
      makeIssue({ projectId: null }),
    ];

    expect(shouldShowBoardProjectChip(issues)).toBe(false);
  });
});
