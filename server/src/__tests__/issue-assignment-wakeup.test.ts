import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
}));

describe("queueIssueAssignmentWakeup", () => {
  it("logs provider rate-limit conflicts at info instead of warn", async () => {
    const err = Object.assign(new Error("Provider rate limit (seven_day)"), {
      status: 409,
      details: { scopeType: "provider", scopeId: "block-1" },
    });
    const heartbeat = {
      wakeup: vi.fn(async () => {
        throw err;
      }),
    };

    await expect(queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
      rethrowOnError: true,
    })).rejects.toBe(err);

    expect(mockLogger.info).toHaveBeenCalledWith(
      { err, issueId: "issue-1" },
      "issue assignment wakeup blocked by provider rate limit",
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("keeps unexpected wakeup failures at warn", async () => {
    const err = Object.assign(new Error("boom"), { status: 500 });
    const heartbeat = {
      wakeup: vi.fn(async () => {
        throw err;
      }),
    };

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-2", assigneeAgentId: "agent-2", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issues.update",
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err, issueId: "issue-2" },
      "failed to wake assignee on issue assignment",
    );
  });
});
