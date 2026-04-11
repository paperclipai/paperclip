import { describe, expect, it } from "vitest";
import { resolveOperationsTruthComment } from "./heartbeat.js";

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
});
