import { describe, expect, it, vi } from "vitest";

vi.mock("../services/activity-log.ts", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

import { runDependencyResolutionHook } from "../services/dependency-resolution-hook.ts";

function makeSelectBuilder(result: unknown) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    then: (onFulfilled?: ((value: unknown) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
      Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined),
  };

  return builder;
}

function makeUpdateBuilder(result: unknown) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve(result)),
      })),
    })),
  };
}

function makeMockDb({
  selectResults,
  updateResults,
  insertedCommentId = "comment-1",
}: {
  selectResults: unknown[];
  updateResults: unknown[];
  insertedCommentId?: string;
}) {
  const selects = [...selectResults];
  const updates = [...updateResults];
  const commentReturning = vi.fn().mockResolvedValue([{ id: insertedCommentId }]);
  const insertValues = vi.fn().mockReturnValue({ returning: commentReturning });

  return {
    select: vi.fn(() => makeSelectBuilder(selects.shift())),
    update: vi.fn(() => makeUpdateBuilder(updates.shift())),
    insert: vi.fn(() => ({ values: insertValues })),
    insertValues,
  };
}

describe("runDependencyResolutionHook", () => {
  it("unblocks the issue, comments, and wakes the CEO when its last dependency resolves", async () => {
    const db = makeMockDb({
      updateResults: [
        [{ id: "dep-1", blockedIssueId: "blocked-1", blockingIssueId: "done-1" }],
        [{ id: "blocked-1", identifier: "KTA-200" }],
      ],
      selectResults: [
        [
          {
            id: "blocked-1",
            companyId: "company-1",
            identifier: "KTA-200",
            title: "Blocked task",
            status: "blocked",
            assigneeAgentId: "agent-2",
          },
        ],
        [],
        [{ id: "ceo-1", name: "CEO", reportsTo: null }],
      ],
      insertedCommentId: "comment-abc",
    });
    const heartbeat = { wakeup: vi.fn().mockResolvedValue(undefined) };

    await runDependencyResolutionHook(
      db as any,
      { id: "done-1", identifier: "KTA-101", companyId: "company-1" },
      heartbeat as any,
    );

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "blocked-1",
        companyId: "company-1",
        body: expect.stringContaining("Auto-unblocked because dependency [KTA-101](/KTA/issues/KTA-101) was completed."),
      }),
    );
    expect(heartbeat.wakeup).toHaveBeenCalledWith(
      "ceo-1",
      expect.objectContaining({
        reason: "dependency_resolved",
        payload: { issueId: "blocked-1", commentId: "comment-abc" },
        contextSnapshot: expect.objectContaining({
          issueId: "blocked-1",
          wakeCommentId: "comment-abc",
          wakeReason: "dependency_resolved",
        }),
      }),
    );
  });

  it("leaves the issue blocked when another dependency is still unresolved", async () => {
    const db = makeMockDb({
      updateResults: [[{ id: "dep-1", blockedIssueId: "blocked-1", blockingIssueId: "done-1" }]],
      selectResults: [
        [
          {
            id: "blocked-1",
            companyId: "company-1",
            identifier: "KTA-200",
            title: "Blocked task",
            status: "blocked",
            assigneeAgentId: "agent-2",
          },
        ],
        [{ id: "dep-2" }],
      ],
    });
    const heartbeat = { wakeup: vi.fn().mockResolvedValue(undefined) };

    await runDependencyResolutionHook(
      db as any,
      { id: "done-1", identifier: "KTA-101", companyId: "company-1" },
      heartbeat as any,
    );

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });
});
