import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("skips wakeups for terminal issue statuses", async () => {
    const wakeup = vi.fn(async () => undefined);
    const heartbeat = { wakeup };

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "done" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-2", assigneeAgentId: "agent-1", status: "cancelled" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("wakes assignees for non-terminal statuses", async () => {
    const wakeup = vi.fn(async () => undefined);
    const heartbeat = { wakeup };

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-3", assigneeAgentId: "agent-2", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });

    expect(wakeup).toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({ issueId: "issue-3" }),
      }),
    );
  });
});
