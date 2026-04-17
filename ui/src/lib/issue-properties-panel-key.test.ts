import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildIssuePropertiesPanelKey } from "./issue-properties-panel-key";

function createIssue(overrides: Partial<Issue> = {}) {
  return {
    id: "issue-1",
    status: "in_progress" as const,
    priority: "medium" as const,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    projectId: "project-1",
    parentId: null,
    createdByUserId: "user-1",
    hiddenAt: null,
    labelIds: ["label-1"],
    executionPolicy: null,
    executionState: null,
    blocks: [],
    blockedBy: [],
    ancestors: [],
    updatedAt: new Date("2026-04-12T12:00:00.000Z"),
    ...overrides,
  };
}

describe("buildIssuePropertiesPanelKey", () => {
  it("ignores plain updatedAt churn", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ updatedAt: new Date("2026-04-12T12:05:00.000Z") }),
      [],
    );

    expect(second).toBe(first);
  });

  it("changes when a displayed property changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ assigneeAgentId: "agent-2" }),
      [],
    );

    expect(second).not.toBe(first);
  });
});
