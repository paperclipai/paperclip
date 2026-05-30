import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

function makeHeartbeat() {
  return { wakeup: vi.fn().mockResolvedValue({}) };
}

describe("queueIssueAssignmentWakeup", () => {
  it("queues a wake for an assigned, non-backlog issue without the marker", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "in_progress",
        description: "a normal issue",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "test.create",
    });
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(heartbeat.wakeup.mock.calls[0]?.[0]).toBe("agent-1");
  });

  it("suppresses the wake when the description carries the placeholder-anchor marker", () => {
    const heartbeat = makeHeartbeat();
    const result = queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "in_progress",
        description: [
          "# Trading-day umbrella placeholder",
          "",
          "Placeholder anchor — DO NOT manually start.",
        ].join("\n"),
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "test.create",
    });
    expect(result).toBeUndefined();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("suppresses the wake when no assignee is present", () => {
    const heartbeat = makeHeartbeat();
    queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-1",
        assigneeAgentId: null,
        status: "in_progress",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "test.create",
    });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("suppresses the wake for backlog status", () => {
    const heartbeat = makeHeartbeat();
    queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "backlog",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "test.create",
    });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });
});
