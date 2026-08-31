import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

function createHeartbeat() {
  return { wakeup: vi.fn().mockResolvedValue({ id: "run-1" }) };
}

describe("queueIssueAssignmentWakeup", () => {
  it("does not create a closed-loop wake when an agent creates its own assigned issue", async () => {
    const heartbeat = createHeartbeat();

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.child_create",
      requestedByActorType: "agent",
      requestedByActorId: "agent-1",
    });

    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("still wakes an agent when a different actor creates the assignment", async () => {
    const heartbeat = createHeartbeat();

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-2", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: "agent",
      requestedByActorId: "agent-1",
    });

    expect(heartbeat.wakeup).toHaveBeenCalledOnce();
    expect(heartbeat.wakeup).toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({ source: "assignment", reason: "issue_assigned" }),
    );
  });

  it("still wakes the same agent for a later assignment mutation", async () => {
    const heartbeat = createHeartbeat();

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
      requestedByActorType: "agent",
      requestedByActorId: "agent-1",
    });

    expect(heartbeat.wakeup).toHaveBeenCalledOnce();
  });
});
