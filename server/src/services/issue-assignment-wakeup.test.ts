import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("does not wake agents for human-control work items", async () => {
    const wakeup = vi.fn().mockResolvedValue(null);

    const result = queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "todo",
        workItemType: "human_task",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });

    expect(result).toBeUndefined();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("wakes assigned agents for AI work items", async () => {
    const wakeup = vi.fn().mockResolvedValue(null);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "todo",
        workItemType: "ai_task",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });

    expect(wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      reason: "issue_assigned",
      payload: { issueId: "issue-1", mutation: "update" },
    }));
  });
});
