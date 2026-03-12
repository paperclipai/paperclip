import { describe, expect, it, vi, beforeEach } from "vitest";
import { runCompletionHook } from "../services/issue-completion-hook.ts";

function makeMockDb({
  parentIssue = {
    id: "parent-1",
    identifier: "KTA-100",
    title: "Parent Task",
    status: "in_progress" as const,
    companyId: "company-1",
    parentId: null,
    assigneeAgentId: "some-agent",
  },
  ceoAgents = [{ id: "ceo-1", name: "CEO", reportsTo: null }],
  insertedCommentId = "comment-1",
} = {}) {
  const returningFn = vi.fn().mockResolvedValue([{ id: insertedCommentId }]);
  const insertValuesFn = vi.fn().mockReturnValue({ returning: returningFn });
  const insertFn = vi.fn().mockReturnValue({ values: insertValuesFn });

  const updateSetFn = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  const updateFn = vi.fn().mockReturnValue({ set: updateSetFn });

  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    insert: insertFn,
    update: updateFn,
  };

  // First .where() call → parent issue lookup
  // Second .where() call → CEO agent lookup
  db.where
    .mockResolvedValueOnce([parentIssue])
    .mockResolvedValueOnce(ceoAgents);

  return { db, returningFn, insertValuesFn };
}

function makeMockHeartbeat() {
  const wakeup = vi.fn().mockResolvedValue(null);
  return { wakeup };
}

describe("runCompletionHook", () => {
  it("skips when no parentId", async () => {
    const { db } = makeMockDb();
    const heartbeat = makeMockHeartbeat();

    await runCompletionHook(
      db as any,
      { id: "issue-1", identifier: "KTA-1", title: "Test", companyId: "company-1", parentId: null },
      heartbeat as any,
    );

    expect(db.select).not.toHaveBeenCalled();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("wakes CEO with correct comment ID in context snapshot", async () => {
    const { db } = makeMockDb({ insertedCommentId: "comment-abc" });
    const heartbeat = makeMockHeartbeat();

    await runCompletionHook(
      db as any,
      {
        id: "subtask-1",
        identifier: "KTA-101",
        title: "Subtask Done",
        companyId: "company-1",
        parentId: "parent-1",
      },
      heartbeat as any,
    );

    expect(heartbeat.wakeup).toHaveBeenCalledOnce();
    const [agentId, opts] = heartbeat.wakeup.mock.calls[0];
    expect(agentId).toBe("ceo-1");
    expect(opts.reason).toBe("subtask_completed");
    expect(opts.source).toBe("automation");
    expect(opts.contextSnapshot?.wakeCommentId).toBe("comment-abc");
    expect(opts.contextSnapshot?.wakeReason).toBe("subtask_completed");
    expect(opts.contextSnapshot?.issueId).toBe("parent-1");
    expect(opts.payload?.commentId).toBe("comment-abc");
  });

  it("does not wake CEO when no heartbeat service provided", async () => {
    const { db } = makeMockDb();

    // Should complete without error even without heartbeat
    await runCompletionHook(
      db as any,
      {
        id: "subtask-1",
        identifier: "KTA-101",
        title: "Subtask Done",
        companyId: "company-1",
        parentId: "parent-1",
      },
    );

    // No wakeup — no heartbeat passed
    // Just verify it didn't throw
  });

  it("skips when parent is already done", async () => {
    const { db } = makeMockDb({
      parentIssue: {
        id: "parent-1",
        identifier: "KTA-100",
        title: "Parent",
        status: "done" as const,
        companyId: "company-1",
        parentId: null,
        assigneeAgentId: null,
      },
    });
    const heartbeat = makeMockHeartbeat();

    await runCompletionHook(
      db as any,
      {
        id: "subtask-1",
        identifier: "KTA-101",
        title: "Subtask",
        companyId: "company-1",
        parentId: "parent-1",
      },
      heartbeat as any,
    );

    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("prefers root CEO (reportsTo=null) when multiple CEO candidates exist", async () => {
    const { db } = makeMockDb({
      ceoAgents: [
        { id: "ceo-secondary", name: "CEO2", reportsTo: "ceo-1" },
        { id: "ceo-1", name: "CEO", reportsTo: null },
      ],
    });
    const heartbeat = makeMockHeartbeat();

    await runCompletionHook(
      db as any,
      {
        id: "subtask-1",
        identifier: "KTA-101",
        title: "Subtask",
        companyId: "company-1",
        parentId: "parent-1",
      },
      heartbeat as any,
    );

    const [agentId] = heartbeat.wakeup.mock.calls[0];
    expect(agentId).toBe("ceo-1");
  });
});
