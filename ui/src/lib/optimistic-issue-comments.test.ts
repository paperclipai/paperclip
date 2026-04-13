import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyOptimisticIssueCommentUpdate,
  createOptimisticIssueComment,
  isQueuedIssueComment,
  mergeIssueComments,
  upsertIssueComment,
} from "./optimistic-issue-comments";

describe("optimistic issue comments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a pending optimistic comment for the current user", () => {
    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Working on it",
      authorUserId: "board-1",
    });

    expect(comment.id).toMatch(/^optimistic-/);
    expect(comment.clientId).toBe(comment.id);
    expect(comment.clientStatus).toBe("pending");
    expect(comment.authorUserId).toBe("board-1");
    expect(comment.authorAgentId).toBeNull();
  });

  it("falls back when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_746_000_000_000);
    const mathSpy = vi.spyOn(Math, "random").mockReturnValue(0.123456789);

    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Working on it",
      authorUserId: "board-1",
    });

    expect(comment.id).toBe("optimistic-1746000000000-4fzzzxjy");
    expect(comment.clientId).toBe(comment.id);

    nowSpy.mockRestore();
    mathSpy.mockRestore();
  });

  it("supports queued optimistic comments for active-run follow-ups", () => {
    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Queue this",
      authorUserId: "board-1",
      clientStatus: "queued",
      queueTargetRunId: "run-1",
    });

    expect(comment.clientStatus).toBe("queued");
    expect(comment.queueTargetRunId).toBe("run-1");
  });

  it("merges optimistic comments into the server thread in chronological order", () => {
    const merged = mergeIssueComments(
      [
        {
          id: "comment-2",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Second",
          createdAt: new Date("2026-03-28T14:00:02.000Z"),
          updatedAt: new Date("2026-03-28T14:00:02.000Z"),
        },
      ],
      [
        {
          id: "optimistic-1",
          clientId: "optimistic-1",
          clientStatus: "pending",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "First",
          createdAt: new Date("2026-03-28T14:00:01.000Z"),
          updatedAt: new Date("2026-03-28T14:00:01.000Z"),
        },
      ],
    );

    expect(merged.map((comment) => comment.id)).toEqual(["optimistic-1", "comment-2"]);
  });

  it("upserts confirmed comments without creating duplicates", () => {
    const next = upsertIssueComment(
      [
        {
          id: "comment-1",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Original",
          createdAt: new Date("2026-03-28T14:00:00.000Z"),
          updatedAt: new Date("2026-03-28T14:00:00.000Z"),
        },
      ],
      {
        id: "comment-1",
        companyId: "company-1",
        issueId: "issue-1",
        authorAgentId: null,
        authorUserId: "board-1",
        body: "Updated",
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:05.000Z"),
      },
    );

    expect(next).toHaveLength(1);
    expect(next[0]?.body).toBe("Updated");
  });

  it("applies optimistic reopen and reassignment updates to the issue cache", () => {
    const next = applyOptimisticIssueCommentUpdate(
      {
        id: "issue-1",
        companyId: "company-1",
        projectId: null,
        projectWorkspaceId: null,
        goalId: null,
        parentId: null,
        title: "Fix comment flow",
        description: null,
        status: "done",
        priority: "medium",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: null,
        createdByUserId: "board-1",
        issueNumber: 1,
        identifier: "PAP-1",
        originKind: "manual",
        originId: null,
        originRunId: null,
        requestDepth: 0,
        billingCode: null,
        assigneeAdapterOverrides: null,
        executionWorkspaceId: null,
        executionWorkspacePreference: null,
        executionWorkspaceSettings: null,
        scheduledFor: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        hiddenAt: null,
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:00.000Z"),
      },
      {
        reopen: true,
        reassignment: {
          assigneeAgentId: null,
          assigneeUserId: "board-2",
        },
      },
    );

    expect(next?.status).toBe("todo");
    expect(next?.assigneeAgentId).toBeNull();
    expect(next?.assigneeUserId).toBe("board-2");
  });

  it("treats comments without a run id as queued when they arrive during an active run", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        runId: null,
      }),
    ).toBe(true);
  });

  it("does not mark comments with an associated run as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        runId: "run-1",
      }),
    ).toBe(false);
  });

  it("does not mark interrupt comments as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        interruptedRunId: "run-1",
      }),
    ).toBe(false);
  });
});
