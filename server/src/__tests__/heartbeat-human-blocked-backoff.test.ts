import { describe, expect, it } from "vitest";
import { shouldBackoffHumanOwnedBlockedIssueWake } from "../services/heartbeat.ts";

// A `blocked` issue with no agent-actionable unblock path can be re-checked-out
// and re-blocked on every timer heartbeat with no new signal. The backoff skips
// that idle re-checkout while preserving every new-signal wake.

describe("shouldBackoffHumanOwnedBlockedIssueWake", () => {
  const base = {
    issueStatus: "blocked" as string | null,
    blockedIssueBackoffEligible: true,
    wakeReason: "heartbeat_timer" as string | null | undefined,
    wakeCommentId: null as string | null | undefined,
  };

  it("backs off an idle timer re-triage of a blocked, backoff-eligible issue", () => {
    expect(shouldBackoffHumanOwnedBlockedIssueWake({ ...base })).toBe(true);
  });

  it("backs off other idle re-triage wakes (issue monitor, reconcile)", () => {
    for (const wakeReason of [
      "issue_monitor_due",
      "issue_continuation_needed",
      "interval_elapsed",
      undefined,
      null,
    ]) {
      expect(
        shouldBackoffHumanOwnedBlockedIssueWake({ ...base, wakeReason }),
      ).toBe(true);
    }
  });

  it("does NOT back off when the issue is not blocked", () => {
    for (const issueStatus of ["todo", "in_progress", "backlog", "in_review", "done", null]) {
      expect(
        shouldBackoffHumanOwnedBlockedIssueWake({ ...base, issueStatus }),
      ).toBe(false);
    }
  });

  it("does NOT back off when the issue has an agent-actionable unblock path", () => {
    expect(
      shouldBackoffHumanOwnedBlockedIssueWake({ ...base, blockedIssueBackoffEligible: false }),
    ).toBe(false);
  });

  it("wakes on a fresh comment attached to the wake (new human/board signal)", () => {
    expect(
      shouldBackoffHumanOwnedBlockedIssueWake({ ...base, wakeCommentId: "comment-123" }),
    ).toBe(false);
  });

  it("wakes on directed / new-signal wake reasons", () => {
    for (const wakeReason of [
      "issue_commented",
      "issue_comment_mentioned",
      "issue_assigned",
      "issue_checked_out",
      "issue_blockers_resolved",
      "source_scoped_recovery_action",
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
      "issue_interaction_resolved",
    ]) {
      expect(
        shouldBackoffHumanOwnedBlockedIssueWake({ ...base, wakeReason }),
      ).toBe(false);
    }
  });
});
