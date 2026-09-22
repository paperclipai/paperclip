import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

describe("issue assignment wakeups", () => {
  it("does not restart an assigned issue while it is blocked", () => {
    const wakeup = vi.fn(async () => undefined);

    queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "blocked" },
      reason: "issue_assigned",
      mutation: "issue.updated",
      contextSource: "issue_update",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("preserves explicit event-driven wakes for blocked issues", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "blocked" },
      reason: "secret_proposal_resolved",
      mutation: "secret_proposal_approved",
      contextSource: "secret.proposal.resolution",
    });

    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      reason: "secret_proposal_resolved",
    }));
  });

  it("continues to wake an assigned in-progress issue", () => {
    const wakeup = vi.fn(async () => undefined);

    queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "in_progress" },
      reason: "issue_assigned",
      mutation: "issue.updated",
      contextSource: "issue_update",
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "assignment",
      reason: "issue_assigned",
    }));
  });

  it("keeps board-owned holds under board control", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: {
        id: "issue-1",
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Wait for Board approval" },
        blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1),
        blockedOwnerNotifiedAt: null,
      },
      wakeup,
      markNotified,
    })).resolves.toBe(false);

    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });
});
