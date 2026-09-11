import { describe, expect, it } from "vitest";
import { shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat.ts";

// ---------------------------------------------------------------------------
// shouldQueueFollowupForRunningIssueWake — decides whether a wake that
// arrives while the same agent already has an active run for the same issue
// must be queued as a real follow-up (`deferred_issue_execution`, promoted
// once the active run finishes) rather than merged into that active run's
// contextSnapshot.
//
// Regression coverage for the `issue_assigned` gap: a plugin (e.g. a
// workflow/graph engine) advancing an issue to its next node fires an
// `issue_assigned` wake for the SAME issue whose own just-finished run is
// often still the "active" run at that exact moment (it produced its final
// disposition but hasn't finished persisting yet). Before this fix,
// `issue_assigned` was absent from RUNNING_ISSUE_WAKE_REASONS_REQUIRING_
// FOLLOWUP, so that wake got silently merged into the already-finishing run
// and never actually executed — the issue's next step never got a real
// heartbeat run. Confirmed live via `agent_wakeup_requests` rows with
// `status: "coalesced"`, `reason: "issue_execution_same_name"` on a WFE
// plugin's `wfe.advance`-sourced `issue_assigned` wake.
// ---------------------------------------------------------------------------
describe("shouldQueueFollowupForRunningIssueWake", () => {
  it("requires a follow-up queue for issue_assigned wakes (the bug fix)", () => {
    expect(
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: { wakeReason: "issue_assigned" },
        wakeCommentId: null,
      }),
    ).toBe(true);
  });

  it("still requires a follow-up queue for the pre-existing reasons", () => {
    expect(
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: { wakeReason: "approval_approved" },
        wakeCommentId: null,
      }),
    ).toBe(true);
    expect(
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: { wakeReason: "issue_blockers_resolved" },
        wakeCommentId: null,
      }),
    ).toBe(true);
  });

  it("always requires a follow-up queue when a wake comment id is present, regardless of reason", () => {
    expect(
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: { wakeReason: "heartbeat_timer" },
        wakeCommentId: "comment-1",
      }),
    ).toBe(true);
  });

  it("does not require a follow-up queue for unrelated wake reasons", () => {
    expect(
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: { wakeReason: "heartbeat_timer" },
        wakeCommentId: null,
      }),
    ).toBe(false);
    expect(
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: { wakeReason: "execution_review_requested" },
        wakeCommentId: null,
      }),
    ).toBe(false);
  });

  it("does not require a follow-up queue when there is no wake reason at all", () => {
    expect(
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: {},
        wakeCommentId: null,
      }),
    ).toBe(false);
    expect(
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: null,
        wakeCommentId: null,
      }),
    ).toBe(false);
  });
});
