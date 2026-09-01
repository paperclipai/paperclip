import { describe, expect, it } from "vitest";
import { normalizeIssueQueuedCommentQueue } from "./issue-queued-comment-queue";

describe("normalizeIssueQueuedCommentQueue", () => {
  it("sorts, deduplicates, and drops malformed queue entries", () => {
    const queue = normalizeIssueQueuedCommentQueue({
      issueId: "issue-1",
      queueId: "wake-1",
      state: "deferred",
      targetRunId: "run-1",
      revision: "rev-1",
      protocol: "paperclip_runner_v1",
      steeringDisposition: "available",
      entries: [
        { comment: { id: "second", body: "Second" }, position: 2, canEdit: true, canDiscard: true },
        { comment: { id: "first", body: "First" }, position: 0, canEdit: false, canDiscard: true },
        { comment: { id: "first", body: "Duplicate" }, position: 1, canEdit: true, canDiscard: true },
        { comment: { body: "Missing id" }, position: 3 },
      ],
    }, "fallback");

    expect(queue.entries.map((entry) => entry.comment.id)).toEqual(["first", "second"]);
    expect(queue.entries.map((entry) => entry.position)).toEqual([0, 1]);
    expect(queue.protocol).toBe("paperclip_runner_v1");
    expect(queue.queueId).toBe("wake-1");
    expect(queue.state).toBe("deferred");
    expect(queue.steeringDisposition).toBe("available");
  });

  it("fails closed for malformed protocol and steering data", () => {
    const queue = normalizeIssueQueuedCommentQueue({ entries: "nope" }, "issue-fallback");
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
});
