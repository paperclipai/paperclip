import { describe, expect, it } from "vitest";
import { shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat.ts";

describe("shouldQueueFollowupForRunningIssueWake", () => {
  it("preserves a deferred fallback while the source turn is still running", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: {
        wakeReason: "issue_commented",
        interactionId: "00000000-0000-4000-8000-000000000001",
        interactionStatus: "accepted",
      },
      wakeCommentId: null,
    })).toBe(true);
  });

  it("still coalesces a generic issue wake without new input", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: { wakeReason: "issue_commented" },
      wakeCommentId: null,
    })).toBe(false);
  });

  it("queues an API child completion behind a running turn so the parent reads the new summary", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: {
        wakeReason: "issue_children_completed",
        source: "issue.children_completed",
        completedChildIssueId: "00000000-0000-4000-8000-000000000002",
      },
      wakeCommentId: null,
    })).toBe(true);
  });

  it("does not queue a child-completion wake that lacks the API source marker", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: { wakeReason: "issue_children_completed" },
      wakeCommentId: null,
    })).toBe(false);
  });
});
