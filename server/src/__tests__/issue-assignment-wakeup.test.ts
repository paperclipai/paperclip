import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("issue assignment wakeup", () => {
  it("passes a stable assignment idempotency key to heartbeat wakeup", async () => {
    const wakeup = vi.fn().mockResolvedValue("ok");
    const heartbeat = { wakeup };

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-123",
        assigneeAgentId: "agent-1",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
      requestedByActorType: "system",
      requestedByActorId: "agent-1",
    });

    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup).toHaveBeenCalledWith("agent-1", {
      source: "assignment",
      triggerDetail: "system",
      idempotencyKey: "issue-assignment:issue-123:create:routine.dispatch",
      reason: "issue_assigned",
      payload: { issueId: "issue-123", mutation: "create" },
      requestedByActorType: "system",
      requestedByActorId: "agent-1",
      contextSnapshot: { issueId: "issue-123", source: "routine.dispatch" },
    });
  });
});
