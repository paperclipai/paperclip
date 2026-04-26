import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn() },
}));

import { logger } from "../middleware/logger.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

function makeWakeup() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeHeartbeat(wakeup = makeWakeup()) {
  return { wakeup };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// queueIssueAssignmentWakeup — early-exit conditions
// ============================================================================

describe("queueIssueAssignmentWakeup — no-op conditions", () => {
  it("returns undefined when assigneeAgentId is null", () => {
    const heartbeat = makeHeartbeat();
    const result = queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: null, status: "in_progress" },
      reason: "test",
      mutation: "update",
      contextSource: "test",
    });
    expect(result).toBeUndefined();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("returns undefined when status is 'backlog'", () => {
    const heartbeat = makeHeartbeat();
    const result = queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "backlog" },
      reason: "test",
      mutation: "update",
      contextSource: "test",
    });
    expect(result).toBeUndefined();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("does not wakeup for both null assignee and backlog status", () => {
    const heartbeat = makeHeartbeat();
    queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: null, status: "backlog" },
      reason: "test",
      mutation: "update",
      contextSource: "test",
    });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });
});

// ============================================================================
// queueIssueAssignmentWakeup — wakeup invocation
// ============================================================================

describe("queueIssueAssignmentWakeup — calls wakeup with correct arguments", () => {
  it("calls wakeup with the agentId from the issue", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-42", status: "in_progress" },
      reason: "my-reason",
      mutation: "status_changed",
      contextSource: "issues-service",
    });
    expect(heartbeat.wakeup).toHaveBeenCalledWith("agent-42", expect.anything());
  });

  it("passes source=assignment and triggerDetail=system", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "r",
      mutation: "m",
      contextSource: "ctx",
    });
    expect(heartbeat.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ source: "assignment", triggerDetail: "system" }),
    );
  });

  it("includes reason and mutation in the wakeup call", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-99", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_updated",
      mutation: "assignee_changed",
      contextSource: "ctx",
    });
    expect(heartbeat.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "issue_updated",
        payload: expect.objectContaining({ issueId: "issue-99", mutation: "assignee_changed" }),
      }),
    );
  });

  it("passes contextSource in contextSnapshot", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-5", assigneeAgentId: "agent-1", status: "in_review" },
      reason: "r",
      mutation: "m",
      contextSource: "workflow-engine",
    });
    expect(heartbeat.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({ source: "workflow-engine" }),
      }),
    );
  });

  it("passes requestedByActorType and requestedByActorId when provided", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "r",
      mutation: "m",
      contextSource: "ctx",
      requestedByActorType: "user",
      requestedByActorId: "user-42",
    });
    expect(heartbeat.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        requestedByActorType: "user",
        requestedByActorId: "user-42",
      }),
    );
  });

  it("defaults requestedByActorId to null when not provided", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "r",
      mutation: "m",
      contextSource: "ctx",
    });
    expect(heartbeat.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ requestedByActorId: null }),
    );
  });

  it("triggers wakeup for in_progress, todo, in_review, blocked statuses", async () => {
    for (const status of ["in_progress", "todo", "in_review", "blocked", "done"]) {
      const heartbeat = makeHeartbeat();
      queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: "issue-1", assigneeAgentId: "agent-1", status },
        reason: "r",
        mutation: "m",
        contextSource: "ctx",
      });
      expect(heartbeat.wakeup).toHaveBeenCalledOnce();
    }
  });
});

// ============================================================================
// queueIssueAssignmentWakeup — error handling
// ============================================================================

describe("queueIssueAssignmentWakeup — error handling", () => {
  it("swallows errors by default and returns null", async () => {
    const wakeup = vi.fn().mockRejectedValueOnce(new Error("network failure"));
    const result = await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "in_progress" },
      reason: "r",
      mutation: "m",
      contextSource: "ctx",
    });
    expect(result).toBeNull();
  });

  it("logs a warning when wakeup fails", async () => {
    const wakeup = vi.fn().mockRejectedValueOnce(new Error("timeout"));
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-7", assigneeAgentId: "agent-1", status: "todo" },
      reason: "r",
      mutation: "m",
      contextSource: "ctx",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue-7" }),
      expect.any(String),
    );
  });

  it("rethrows when rethrowOnError=true", async () => {
    const err = new Error("critical failure");
    const wakeup = vi.fn().mockRejectedValueOnce(err);
    await expect(
      queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
        reason: "r",
        mutation: "m",
        contextSource: "ctx",
        rethrowOnError: true,
      }),
    ).rejects.toThrow("critical failure");
  });

  it("does not rethrow by default when wakeup fails", async () => {
    const wakeup = vi.fn().mockRejectedValueOnce(new Error("fail"));
    await expect(
      queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
        reason: "r",
        mutation: "m",
        contextSource: "ctx",
      }),
    ).resolves.not.toThrow();
  });
});
