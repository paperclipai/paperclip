import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("forwards silent completion and onComplete follow-up settings to heartbeat wakeups", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "run-1" });

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
      requestedByActorType: "system",
      silentCompletion: true,
      onComplete: {
        issueStatus: "blocked",
        onlyOn: ["failed", "timed_out"],
      },
    });

    expect(wakeup).toHaveBeenCalledWith("agent-1", {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: "issue-1", mutation: "create" },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: { issueId: "issue-1", source: "routine.dispatch" },
      silentCompletion: true,
      onComplete: {
        issueStatus: "blocked",
        onlyOn: ["failed", "timed_out"],
      },
    });
  });
});
