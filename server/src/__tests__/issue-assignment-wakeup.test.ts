import { HttpError } from "../errors.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
  httpLogger: {},
}));

import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("logs a structured skip event when the assignee is not invokable", async () => {
    const wakeup = vi.fn(async () => {
      throw new HttpError(409, "Agent is not invokable in its current state", { status: "paused" });
    });
    const heartbeat = { wakeup };

    const result = await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-4", assigneeAgentId: "agent-4", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });

    expect(result).toEqual({
      status: "warning",
      warning: {
        code: "paused",
        message: "Assignee is paused and cannot be started right now.",
      },
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "heartbeat.wakeup.skipped_not_invokable",
        issueId: "issue-4",
        agentId: "agent-4",
        reason: "issue_assigned",
        mutation: "update",
        agentStatus: "paused",
      }),
      "heartbeat.wakeup.skipped_not_invokable",
    );
  });

  it("logs a structured failure event when the assignee wakeup throws", async () => {
    const wakeup = vi.fn(async () => {
      throw new HttpError(409, "Execution blocked", { code: "execution_blocked" });
    });
    const heartbeat = { wakeup };

    const result = await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-5", assigneeAgentId: "agent-5", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });

    expect(result).toEqual({
      status: "warning",
      warning: {
        code: "execution_blocked",
        message: "Execution blocked",
      },
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "heartbeat.wakeup.failed",
        issueId: "issue-5",
        agentId: "agent-5",
        reason: "issue_assigned",
        mutation: "update",
        errorCode: "execution_blocked",
      }),
      "heartbeat.wakeup.failed",
    );
  });
});
