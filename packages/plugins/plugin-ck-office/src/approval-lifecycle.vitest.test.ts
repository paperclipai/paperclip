import assert from "node:assert/strict";
import { test } from "vitest";
import {
  acceptedApprovalGateFailureState,
  approvalQueueCollision,
  interactionClosesPendingOutreach,
  issueAwaitsHumanApproval,
  outboxSendCompletionState,
  outreachApprovalContinuationPolicy,
  outreachApprovalSupersedesOnUserComment,
} from "./approval-lifecycle.js";

test("stall watchdog ignores issues that are waiting for a human approval", () => {
  const pending = new Set(["issue-waiting"]);
  assert.equal(issueAwaitsHumanApproval("issue-waiting", pending), true);
  assert.equal(issueAwaitsHumanApproval("issue-actually-stalled", pending), false);
});

test("a live approval on another issue makes the new account task a duplicate", () => {
  assert.deepEqual(approvalQueueCollision("new-issue", "canonical-issue"), {
    sameIssue: false,
    issueStatus: "cancelled",
  });
  assert.deepEqual(approvalQueueCollision("canonical-issue", "canonical-issue"), {
    sameIssue: true,
    issueStatus: "in_review",
  });
});

test("outreach approval continues on both accept and hold feedback", () => {
  assert.equal(outreachApprovalContinuationPolicy(), "wake_assignee");
});

test("a normal task reply replaces the stale outreach approval", () => {
  assert.equal(outreachApprovalSupersedesOnUserComment(), true);
});

test("outbox send accepts the shared decision and completes the task", () => {
  assert.deepEqual(outboxSendCompletionState(), {
    interactionStatus: "accepted",
    interactionOutcome: "accepted",
    completionSurface: "outreach_outbox",
    issueStatus: "done",
  });
});

test("a newly-invalid accepted copy closes before revision instead of retrying forever", () => {
  assert.deepEqual(acceptedApprovalGateFailureState(), {
    interactionStatus: "rejected",
    interactionOutcome: "rejected",
    outboxStatus: "cancelled",
  });
});

test("rejected and comment-superseded cards close the linked outbox row", () => {
  assert.equal(interactionClosesPendingOutreach("rejected"), true);
  assert.equal(interactionClosesPendingOutreach("expired"), true);
  assert.equal(interactionClosesPendingOutreach("pending"), false);
  assert.equal(interactionClosesPendingOutreach("accepted"), false);
});
