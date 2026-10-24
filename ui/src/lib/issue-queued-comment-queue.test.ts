import { describe, expect, it } from "vitest";
import type { RunForIssue } from "../api/activity";
import {
  isOpeningChannelMessageQueue,
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

describe("received opening channel messages", () => {
  const opening = {
    ...comment("opening", "Review this change"),
    metadata: { version: 1 as const, sourceChannel: "slack" as const, sections: [] },
  };
  const run: RunForIssue = {
    runId: "first-run", agentId: "agent-1", adapterType: "paperclip_runner",
    invocationSource: "assignment", status: "queued", startedAt: null, finishedAt: null,
    createdAt: "2026-09-04T12:00:01.000Z", contextIssueId: "issue-1",
    wakeupRequestId: "opening-wake", wakeCommentIds: [opening.id],
    usageJson: null, resultJson: null,
  };
  const queue = normalizeIssueQueuedCommentQueue({
    issueId: "issue-1", queueId: "opening-wake", state: "queued",
    entries: [{ comment: opening, position: 0, canEdit: true, canDiscard: true }],
  }, "issue-1");

  it("keeps the saved opener in history without consuming or changing the queue", () => {
    const before = structuredClone(queue);
    expect(isOpeningChannelMessageQueue({ queue, runs: [run], comments: [opening] })).toBe(true);
    expect(queue).toEqual(before);
  });

  it("keeps a follow-up pending after an earlier turn", () => {
    expect(isOpeningChannelMessageQueue({ queue, runs: [
      { ...run, runId: "earlier", status: "succeeded", wakeupRequestId: "earlier-wake" }, run,
    ], comments: [opening] })).toBe(false);
  });

  it("keeps a retry pending even when its predecessor is not loaded", () => {
    expect(isOpeningChannelMessageQueue({ queue, runs: [{ ...run, retryOfRunId: "earlier" }], comments: [opening] })).toBe(false);
  });

  it("does not hide a queue before the saved comment or matching run arrives", () => {
    expect(isOpeningChannelMessageQueue({ queue, runs: [run], comments: [] })).toBe(false);
    expect(isOpeningChannelMessageQueue({ queue, runs: [], comments: [opening] })).toBe(false);
    expect(isOpeningChannelMessageQueue({ queue, runs: [{ ...run, wakeupRequestId: "other-wake" }], comments: [opening] })).toBe(false);
  });

  it("keeps ordinary board messages pending until their run starts", () => {
    expect(isOpeningChannelMessageQueue({ queue, runs: [run], comments: [{ ...opening, metadata: null }] })).toBe(false);
  });

  it("keeps deferred messages and explicit execution waits visible", () => {
    expect(isOpeningChannelMessageQueue({ queue: { ...queue, state: "deferred" }, runs: [run], comments: [opening] })).toBe(false);
    expect(isOpeningChannelMessageQueue({ queue: { ...queue, executionWait: { reason: "budget", message: "Budget exhausted" } }, runs: [run], comments: [opening] })).toBe(false);
  });

  it("keeps a coalesced batch in its editable queue", () => {
    const followUp = comment("follow-up", "Also check this");
    expect(isOpeningChannelMessageQueue({
      queue: { ...queue, entries: [...queue.entries, { comment: followUp, position: 1, canEdit: true, canDiscard: true }] },
      runs: [run], comments: [opening, followUp],
    })).toBe(false);
    expect(isOpeningChannelMessageQueue({ queue, runs: [{ ...run, wakeCommentIds: [opening.id, followUp.id] }], comments: [opening] })).toBe(false);
  });

  it("does not mistake a later coalesced channel comment for the opener", () => {
    expect(isOpeningChannelMessageQueue({ queue, runs: [run], comments: [{ ...opening, createdAt: new Date("2026-09-04T12:00:02.000Z") }] })).toBe(false);
  });
});

describe("normalizeIssueQueuedCommentQueue", () => {
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
