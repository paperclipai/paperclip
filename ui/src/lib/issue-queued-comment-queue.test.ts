import { describe, expect, it } from "vitest";
import {
  mergePendingIssueQueuedComments,
  normalizeIssueQueuedCommentQueue,
  startingQueuedCommentIds,
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
  it("keeps later inputs and uncertain or retry queues editable", () => {
    const opener = comment("opener", "Start this turn");
    const later = { ...comment("later", "Follow up"), createdAt: new Date("2026-09-04T12:00:02Z") };
    const queue = normalizeIssueQueuedCommentQueue({ queueId: "wake", state: "queued",
      entries: [opener, later].map(comment => ({ comment })) }, "issue-1");
    const run = { runId: "run", contextIssueId: "issue-1", wakeupRequestId: "wake", status: "queued",
      startedAt: null, createdAt: "2026-09-04T12:00:01Z", wakeCommentIds: [opener.id, later.id] };
    const ids = (runs: unknown[], value = queue) => [...startingQueuedCommentIds(value, runs as import("../api/activity").RunForIssue[])];
    expect(ids([run])).toEqual(["opener"]);
    expect(ids([{ ...run, retryOfRunId: "prior" }])).toEqual([]);
    expect(ids([{ ...run, wakeupRequestId: "new-wake" }])).toEqual([]);
    expect(ids([{ ...run, contextIssueId: "other-issue" }])).toEqual([]);
    expect(ids([])).toEqual([]);
    expect(ids([run], { ...queue, targetRunId: "previous", state: "deferred" })).toEqual([]);
    expect(ids([run], { ...queue, entries: [{ ...queue.entries[0]!, source: { kind: "interaction", interactionId: "decision", interactionKind: "request_confirmation", requiresFreshSession: false } }] })).toEqual([]);
  });
  it("retains the immutable response and fresh-turn requirement", () => {
    const source = { kind: "interaction", interactionId: "approval-1", interactionKind: "request_confirmation", requiresFreshSession: true };
    const normalized = normalizeIssueQueuedCommentQueue({ entries: [{ comment: comment("approval-1", "Accepted: Plan"), source,
      canEdit: false, canDiscard: false }] }, "issue-1");
    expect(normalized.entries[0]).toMatchObject({ source, canEdit: false, canDiscard: false });
  });
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
        executionWait: { reason: "remote_cleanup", message: "Waiting for the previous environment to stop." },
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
    expect(queue.executionWait?.reason).toBe("remote_cleanup");
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

  it("keeps native steering while an empty queue snapshot predates the submitted message", () => {
    const authoritativeQueue = normalizeIssueQueuedCommentQueue({
      protocol: "legacy", entries: [],
    }, "issue-1");
    const queue = mergePendingIssueQueuedComments({
      issueId: "issue-1", authoritativeQueue,
      pendingComments: [{ comment: comment("optimistic-1", "Use the new model next turn"), targetRunId: "run-native" }],
      fallbackProtocol: "paperclip_runner_v1",
    });
    expect(queue).toMatchObject({ protocol: "paperclip_runner_v1", steeringDisposition: "temporarily_unavailable" });
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
        executionWait: { reason: "remote_cleanup", message: "Waiting for the previous environment to stop." },
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
    expect(queue?.executionWait?.reason).toBe("remote_cleanup");
    expect(queue?.entries.map((entry) => entry.comment.id)).toEqual([
      "comment-1",
    ]);
  });
});
