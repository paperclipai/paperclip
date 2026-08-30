import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { groupTodayIssues } from "./Today";

function issue(id: string, status: Issue["status"], overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: id,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 1,
    identifier: id,
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
    createdAt: new Date("2026-08-29T09:00:00-04:00"),
    updatedAt: new Date("2026-08-29T09:00:00-04:00"),
    ...overrides,
  };
}

describe("groupTodayIssues", () => {
  it("maps Paperclip states into Nate's five work sections", () => {
    const now = new Date("2026-08-29T12:00:00-04:00");
    const grouped = groupTodayIssues([
      issue("blocked", "blocked"),
      issue("review", "in_review"),
      issue("working", "in_progress"),
      issue("next", "todo"),
      issue("plan", "todo", { workMode: "planning" }),
      issue("done", "done", { completedAt: new Date("2026-08-29T11:00:00-04:00") }),
      issue("old", "done", { completedAt: new Date("2026-08-28T11:00:00-04:00") }),
    ], now);

    expect(grouped.needsYou.map((row) => row.id)).toEqual(["blocked"]);
    expect(grouped.ready.map((row) => row.id)).toEqual(["review"]);
    expect(grouped.working.map((row) => row.id)).toEqual(["working"]);
    expect(grouped.upNext.map((row) => row.id)).toEqual(["next"]);
    expect(grouped.done.map((row) => row.id)).toEqual(["done"]);
    expect(Object.values(grouped).flat().map((row) => row.id)).not.toContain("plan");
  });
});
