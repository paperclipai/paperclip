import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { issueActivityText } from "./IssueColumns";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    ownerAgentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    missionControl: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    ...overrides,
  };
}

describe("issueActivityText", () => {
  it("prefers compact activity summaries when present", () => {
    const text = issueActivityText(makeIssue({
      latestActivitySummary: {
        kind: "activity",
        action: "issue.blockers_updated",
        text: "Updated blockers",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        userId: null,
        createdAt: new Date(),
      },
    }));

    expect(text).toContain("Updated blockers");
  });
});
