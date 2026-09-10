import { describe, expect, it } from "vitest";
import {
  mergePendingIssueQueuedComments,
  normalizeIssueQueuedCommentQueue,
} from "./issue-queued-comment-queue";

function comment(id: string, body: string) {
  const now = new Date("2026-09-04T12:00:00.000Z");
  return {
    id,
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user" as const,
    authorAgentId: null,
    authorUserId: "user-1",
    body,
    presentation: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("normalizeIssueQueuedCommentQueue", () => {
  it("sorts, deduplicates, and drops malformed queue entries", () => {
    const queue = normalizeIssueQueuedCommentQueue(
      {
        issueId: "issue-1",
        queueId: "wake-1",
        state: "deferred",
        targetRunId: "run-1",
        revision: "rev-1",
        protocol: "paperclip_runner_v1",
        steeringDisposition: "available",
        entries: [
          {
            comment: { id: "second", body: "Second" },
            position: 2,
            canEdit: true,
            canDiscard: true,
          },
          {
            comment: { id: "first", body: "First" },
            position: 0,
            canEdit: false,
            canDiscard: true,
          },
          {
            comment: { id: "first", body: "Duplicate" },
            position: 1,
            canEdit: true,
            canDiscard: true,
          },
          { comment: { body: "Missing id" }, position: 3 },
        ],
      },
      "fallback",
    );

    expect(queue.entries.map((entry) => entry.comment.id)).toEqual([
      "first",
      "second",
    ]);
    expect(queue.entries.map((entry) => entry.position)).toEqual([0, 1]);
    expect(queue.protocol).toBe("paperclip_runner_v1");
    expect(queue.queueId).toBe("wake-1");
    expect(queue.state).toBe("deferred");
    expect(queue.steeringDisposition).toBe("available");
  });

  it("fails closed for malformed protocol and steering data", () => {
    const queue = normalizeIssueQueuedCommentQueue(
      { entries: "nope" },
      "issue-fallback",
    );
    expect(queue).toMatchObject({
      issueId: "issue-fallback",
      queueId: null,
      state: null,
      targetRunId: null,
      revision: "unavailable",
      protocol: "legacy",
      steeringDisposition: "unsupported",
      entries: [],
    });
  });

  it("projects a new follow-up into an inert queue before server acknowledgement", () => {
    const pending = comment("optimistic-1", "Use three seconds instead");
    const queue = mergePendingIssueQueuedComments({
      issueId: "issue-1",
      authoritativeQueue: null,
      pendingComments: [{ comment: pending, targetRunId: "run-1" }],
      fallbackProtocol: "paperclip_runner_v1",
    });

    expect(queue).toMatchObject({
      queueId: null,
      state: "deferred",
      targetRunId: "run-1",
      protocol: "paperclip_runner_v1",
      steeringDisposition: "temporarily_unavailable",
      entries: [
        {
          comment: { id: "optimistic-1", body: "Use three seconds instead" },
          position: 0,
          canEdit: false,
          canDiscard: true,
        },
      ],
    });
  });

  it("deduplicates acknowledged entries and restores the authoritative queue identity", () => {
    const pending = comment("comment-1", "Use three seconds instead");
    const authoritativeQueue = normalizeIssueQueuedCommentQueue(
      {
        issueId: "issue-1",
        queueId: "wake-1",
        state: "deferred",
        targetRunId: "run-1",
        revision: "rev-1",
        protocol: "paperclip_runner_v1",
        steeringDisposition: "available",
        entries: [
          {
            comment: pending,
            position: 0,
            canEdit: true,
            canDiscard: true,
          },
        ],
      },
      "issue-1",
    );

    const queue = mergePendingIssueQueuedComments({
      issueId: "issue-1",
      authoritativeQueue,
      pendingComments: [{ comment: pending, targetRunId: "run-1" }],
      fallbackProtocol: "legacy",
    });

    expect(queue?.queueId).toBe("wake-1");
    expect(queue?.steeringDisposition).toBe("available");
    expect(queue?.entries.map((entry) => entry.comment.id)).toEqual([
      "comment-1",
    ]);
  });
});
