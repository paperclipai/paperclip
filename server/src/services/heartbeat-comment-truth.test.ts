import { describe, expect, it } from "vitest";
import {
  classifyIssueTruthFromCommentBody,
  resolveOperationsTruthComment,
  resolveLatestStructuredTruthComment,
  shouldSuppressOperationsRecoveryTarget,
} from "./heartbeat.js";

describe("resolveOperationsTruthComment", () => {
  it("falls back to the latest non-operations truth comment when the latest comment is only operations heartbeat noise", () => {
    const handoffComment = {
      issueId: "issue-1",
      body: "## Reassigned To COO For Local Execution Ownership\n\nReassigning to COO for live restaurant-side execution.",
      createdAt: new Date("2026-04-11T14:20:46.579Z"),
    };
    const latestOperationsComment = {
      issueId: "issue-1",
      body:
        "[operations-heartbeat-assignment]\n[@CMO](agent://placeholder) operations heartbeat assigned this issue for active work.\nReason: stale or blocked assigned work: status is blocked.\nPlease resume work now, or leave issue-level truth (status/outcome with blocker, handoff, completion, or wait-state).",
      createdAt: new Date("2026-04-11T14:20:48.762Z"),
    };

    expect(
      resolveOperationsTruthComment({
        latestComment: latestOperationsComment,
        latestNonOperationsComment: handoffComment,
      }),
    ).toEqual(handoffComment);
  });

  it("keeps the latest comment when it is not an operations heartbeat marker", () => {
    const handoffComment = {
      issueId: "issue-1",
      body: "## Reassigned To COO For Local Execution Ownership\n\nReassigning to COO for live restaurant-side execution.",
      createdAt: new Date("2026-04-11T14:20:46.579Z"),
    };

    expect(
      resolveOperationsTruthComment({
        latestComment: handoffComment,
        latestNonOperationsComment: null,
      }),
    ).toEqual(handoffComment);
  });

  it("treats [READY FOR QA] as handoff truth and suppresses fresh recovery nudges", () => {
    const body = "[READY FOR QA]\nImplementation is complete. QA should verify checkout totals.";

    expect(classifyIssueTruthFromCommentBody(body)).toBe("handoff");
    expect(
      shouldSuppressOperationsRecoveryTarget({
        status: "in_progress",
        latestCommentBody: body,
        latestCommentAgeHours: 1,
        hasBlockers: false,
      }),
    ).toBe(true);
  });

  it("does not treat incidental transcript phrases as wait-state truth", () => {
    const body = [
      "Working on issue e2ddfdb4-3d86-4a68-b551-f214305c14c7 — Cart UX trust audit QA gate.",
      "Let me first fetch the issue details and check my environment.",
      "The API still rejects patch requests because of a stale execution lock and a missing permission error from a prior session.",
      "I will inspect what should happen before entering in_review once the lock is cleared.",
    ].join("\n");

    expect(classifyIssueTruthFromCommentBody(body)).toBe(null);
    expect(
      shouldSuppressOperationsRecoveryTarget({
        status: "in_progress",
        latestCommentBody: body,
        latestCommentAgeHours: 1,
        hasBlockers: false,
      }),
    ).toBe(false);
  });

  it("recognizes explicit bracketed blocker and handoff markers", () => {
    expect(classifyIssueTruthFromCommentBody("[HANDOFF]\nQA should verify checkout totals.")).toBe("handoff");
    expect(classifyIssueTruthFromCommentBody("[QA ROUTE]\nRouted to QA.")).toBe("handoff");
    expect(classifyIssueTruthFromCommentBody("[BLOCKER]\nWaiting on product clarification.")).toBe("blocker");
    expect(classifyIssueTruthFromCommentBody("[AUTO-FIX BLOCKED]\npnpm test:run failed.")).toBe("blocker");
    expect(classifyIssueTruthFromCommentBody("[POISONED SESSION]\nContext window exhausted.")).toBe("blocker");
    expect(classifyIssueTruthFromCommentBody("[QA PASS]\nVerified in staging.")).toBe("completion");
    expect(classifyIssueTruthFromCommentBody("[RELEASE CONFIRMED]\nRelease branch validated.")).toBe("completion");
    expect(
      shouldSuppressOperationsRecoveryTarget({
        status: "in_progress",
        latestCommentBody: "[BLOCKER]\nWaiting on product clarification.",
        latestCommentAgeHours: 1,
        hasBlockers: false,
      }),
    ).toBe(true);
    expect(
      shouldSuppressOperationsRecoveryTarget({
        status: "in_progress",
        latestCommentBody: "[POISONED SESSION]\nContext window exhausted.",
        latestCommentAgeHours: 1,
        hasBlockers: false,
      }),
    ).toBe(true);
  });

  it("ignores structured truth markers when they only appear inside fenced transcript blocks", () => {
    const body = [
      "Here is the previous transcript for reference:",
      "```",
      "Workflow gate: requires QA assignee before entering in_review.",
      "Missing permission: tasks:assign.",
      "Board action required.",
      "```",
    ].join("\n");

    expect(classifyIssueTruthFromCommentBody(body)).toBe(null);
    expect(
      shouldSuppressOperationsRecoveryTarget({
        status: "in_progress",
        latestCommentBody: body,
        latestCommentAgeHours: 1,
        hasBlockers: false,
      }),
    ).toBe(false);
  });

  it("keeps the latest structured truth comment even when newer non-operations chatter exists", () => {
    const structuredTruthComment = {
      issueId: "issue-1",
      body: "Workflow gate: requires QA assignee before entering in_review.\nBoard action required.",
      createdAt: new Date("2026-04-11T14:20:46.579Z"),
    };
    const newerChatterComment = {
      issueId: "issue-1",
      body: "I pinged QA and I am waiting for a reply.",
      createdAt: new Date("2026-04-11T14:25:46.579Z"),
    };

    expect(
      resolveLatestStructuredTruthComment([
        newerChatterComment,
        structuredTruthComment,
      ]),
    ).toEqual(structuredTruthComment);
  });
});
