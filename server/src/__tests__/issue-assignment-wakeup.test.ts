import { describe, expect, it, vi } from "vitest";
import {
  getIssueAssignmentWakeupSuppressionReason,
  queueIssueAssignmentWakeup,
} from "../services/issue-assignment-wakeup.js";

describe("getIssueAssignmentWakeupSuppressionReason", () => {
  it("suppresses wakes for blocked issues", () => {
    expect(
      getIssueAssignmentWakeupSuppressionReason({
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "blocked",
      }),
    ).toBe("blocked");
  });

  it("suppresses wakes when execution is already locked", () => {
    expect(
      getIssueAssignmentWakeupSuppressionReason({
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "todo",
        executionRunId: "run-1",
      }),
    ).toBe("execution_already_locked");
  });

  it("allows wakes for actionable assigned issues", () => {
    expect(
      getIssueAssignmentWakeupSuppressionReason({
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "todo",
        executionRunId: null,
      }),
    ).toBeNull();
  });
});

describe("queueIssueAssignmentWakeup", () => {
  it("does not call heartbeat.wakeup when suppression reason exists", async () => {
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "blocked",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("queues the wakeup for actionable issues", async () => {
    const wakeup = vi.fn(async () => ({ id: "wake-1" }));

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "issue-1",
        assigneeAgentId: "agent-1",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "assignment",
        payload: { issueId: "issue-1", mutation: "create" },
        reason: "issue_assigned",
      }),
    );
  });
});
