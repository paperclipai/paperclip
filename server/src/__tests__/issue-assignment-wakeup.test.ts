import { describe, expect, it, vi } from "vitest";
import {
  queueIssueAssignmentWakeup,
  shouldWakeAssigneeForIssueStatus,
} from "../services/issue-assignment-wakeup.ts";

describe("shouldWakeAssigneeForIssueStatus", () => {
  it("wakes only executable assignment statuses", () => {
    expect(shouldWakeAssigneeForIssueStatus("todo")).toBe(true);
    expect(shouldWakeAssigneeForIssueStatus("in_progress")).toBe(true);
    expect(shouldWakeAssigneeForIssueStatus("in_review")).toBe(true);

    expect(shouldWakeAssigneeForIssueStatus("backlog")).toBe(false);
    expect(shouldWakeAssigneeForIssueStatus("blocked")).toBe(false);
    expect(shouldWakeAssigneeForIssueStatus("done")).toBe(false);
    expect(shouldWakeAssigneeForIssueStatus("cancelled")).toBe(false);
  });
});

describe("queueIssueAssignmentWakeup", () => {
  it("does not wake agents for already-blocked assigned issues", async () => {
    const wakeup = vi.fn();

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "issue-blocked",
        assigneeAgentId: "agent-1",
        status: "blocked",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("wakes agents for todo assigned issues", async () => {
    const wakeup = vi.fn().mockResolvedValue({});

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "issue-todo",
        assigneeAgentId: "agent-1",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      reason: "issue_assigned",
      payload: { issueId: "issue-todo", mutation: "create" },
      contextSnapshot: { issueId: "issue-todo", source: "issue.create" },
    }));
  });
});
