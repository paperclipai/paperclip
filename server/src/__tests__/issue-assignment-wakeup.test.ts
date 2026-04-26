import { describe, it, expect, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWakeup() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeIssue(overrides: Partial<{ id: string; assigneeAgentId: string | null; status: string }> = {}) {
  return { id: "issue-123", assigneeAgentId: "agent-abc", status: "open", ...overrides };
}

// ---------------------------------------------------------------------------
// queueIssueAssignmentWakeup
// ---------------------------------------------------------------------------

describe("queueIssueAssignmentWakeup", () => {
  it("calls wakeup with the correct parameters when assignee is present", async () => {
    const wakeup = makeWakeup();
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: makeIssue(),
      reason: "assigned",
      mutation: "issue.assign",
      contextSource: "api",
    });
    expect(wakeup).toHaveBeenCalledOnce();
    const [agentId, opts] = wakeup.mock.calls[0] as [string, Record<string, unknown>];
    expect(agentId).toBe("agent-abc");
    expect(opts).toMatchObject({
      source: "assignment",
      triggerDetail: "system",
      reason: "assigned",
      payload: { issueId: "issue-123", mutation: "issue.assign" },
    });
  });

  it("includes contextSnapshot with issueId and contextSource", async () => {
    const wakeup = makeWakeup();
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: makeIssue(),
      reason: "assigned",
      mutation: "issue.assign",
      contextSource: "webhooks",
    });
    const opts = wakeup.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.contextSnapshot).toEqual({ issueId: "issue-123", source: "webhooks" });
  });

  it("does NOT call wakeup when assigneeAgentId is null", async () => {
    const wakeup = makeWakeup();
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: makeIssue({ assigneeAgentId: null }),
      reason: "assigned",
      mutation: "issue.assign",
      contextSource: "api",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does NOT call wakeup when issue status is 'backlog'", async () => {
    const wakeup = makeWakeup();
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: makeIssue({ status: "backlog" }),
      reason: "assigned",
      mutation: "issue.assign",
      contextSource: "api",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("passes requestedByActorType and requestedByActorId through to wakeup", async () => {
    const wakeup = makeWakeup();
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: makeIssue(),
      reason: "assigned",
      mutation: "issue.assign",
      contextSource: "api",
      requestedByActorType: "user",
      requestedByActorId: "user-xyz",
    });
    const opts = wakeup.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.requestedByActorType).toBe("user");
    expect(opts.requestedByActorId).toBe("user-xyz");
  });

  it("defaults requestedByActorId to null when not provided", async () => {
    const wakeup = makeWakeup();
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: makeIssue(),
      reason: "assigned",
      mutation: "issue.assign",
      contextSource: "api",
    });
    const opts = wakeup.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.requestedByActorId).toBeNull();
  });

  it("swallows errors by default (rethrowOnError=false)", async () => {
    const wakeup = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(
      queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: makeIssue(),
        reason: "assigned",
        mutation: "issue.assign",
        contextSource: "api",
      }),
    ).resolves.toBeNull();
  });

  it("rethrows errors when rethrowOnError=true", async () => {
    const wakeup = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(
      queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: makeIssue(),
        reason: "assigned",
        mutation: "issue.assign",
        contextSource: "api",
        rethrowOnError: true,
      }),
    ).rejects.toThrow("queue unavailable");
  });
});
