import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs info with assignee status for non-invokable assignee conflicts", async () => {
    const wakeup = vi
      .fn()
      .mockRejectedValue(new HttpError(409, "Agent is not invokable in its current state", { status: "paused" }));
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const result = await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(result).toBeNull();
    expect(wakeup).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "issue-1",
        assigneeAgentId: "agent-1",
        assigneeStatus: "paused",
      }),
      "skipped assignee wake on issue assignment: assignee not invokable",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs warn for unexpected wakeup failures", async () => {
    const wakeup = vi.fn().mockRejectedValue(new Error("boom"));
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const result = await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-2", assigneeAgentId: "agent-2", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
