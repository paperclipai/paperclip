import type { Issue } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { formatLocalDateOnly } from "./issue-due-date";
import { applyIssueFilters, defaultIssueFilterState } from "./issue-filters";

function issue(id: string, dueDate: string | null, status: Issue["status"] = "todo"): Issue {
  return {
    id,
    dueDate,
    status,
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    labelIds: [],
    projectId: null,
    executionWorkspaceId: null,
    projectWorkspaceId: null,
    originKind: "manual",
  } as unknown as Issue;
}

describe("issue filters", () => {
  it("filters issues by due date state", () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const issues = [
      issue("overdue", formatLocalDateOnly(yesterday)),
      issue("today", formatLocalDateOnly(today)),
      issue("upcoming", formatLocalDateOnly(tomorrow)),
      issue("none", null),
      issue("done", formatLocalDateOnly(yesterday), "done"),
    ];

    const overdue = applyIssueFilters(issues, {
      ...defaultIssueFilterState,
      dueStates: ["overdue"],
    });
    expect(overdue.map((entry) => entry.id)).toEqual(["overdue"]);

    const noDueDate = applyIssueFilters(issues, {
      ...defaultIssueFilterState,
      dueStates: ["none"],
    });
    expect(noDueDate.map((entry) => entry.id)).toEqual(["none"]);
  });
});
