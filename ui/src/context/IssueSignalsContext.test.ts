import { describe, expect, it } from "vitest";
import { buildAwaitingCounts } from "./IssueSignalsContext";

describe("buildAwaitingCounts", () => {
  it("counts pending issue-thread interactions per issue", () => {
    const counts = buildAwaitingCounts([
      {
        sourceKind: "issue_thread_interaction",
        subject: { kind: "interaction", id: "int-1" },
        relatedIssue: { kind: "issue", id: "issue-1" },
      },
      {
        sourceKind: "issue_thread_interaction",
        subject: { kind: "interaction", id: "int-2" },
        relatedIssue: { kind: "issue", id: "issue-1" },
      },
      {
        sourceKind: "issue_thread_interaction",
        subject: { kind: "interaction", id: "int-3" },
        relatedIssue: { kind: "issue", id: "issue-2" },
      },
    ]);

    expect(counts.get("issue-1")).toBe(2);
    expect(counts.get("issue-2")).toBe(1);
  });

  it("falls back to the subject when it is the issue itself", () => {
    const counts = buildAwaitingCounts([
      {
        sourceKind: "issue_thread_interaction",
        subject: { kind: "issue", id: "issue-9" },
        relatedIssue: null,
      },
    ]);

    expect(counts.get("issue-9")).toBe(1);
  });

  it("ignores every other attention source", () => {
    // Approvals, reviews, failed runs and blockers each have their own inbox
    // row and their own affordance. Folding them into the same dot would make
    // the dot mean "something, somewhere" instead of "answer this question".
    const counts = buildAwaitingCounts([
      { sourceKind: "approval", relatedIssue: { kind: "issue", id: "issue-1" } },
      { sourceKind: "review", relatedIssue: { kind: "issue", id: "issue-1" } },
      { sourceKind: "failed_run", relatedIssue: { kind: "issue", id: "issue-1" } },
      { sourceKind: "blocker_attention", relatedIssue: { kind: "issue", id: "issue-1" } },
    ]);

    expect(counts.size).toBe(0);
  });

  it("skips interactions that resolve to no issue", () => {
    const counts = buildAwaitingCounts([
      { sourceKind: "issue_thread_interaction", subject: { kind: "interaction", id: "int-1" }, relatedIssue: null },
      { sourceKind: "issue_thread_interaction", relatedIssue: { kind: "issue", id: null } },
    ]);

    expect(counts.size).toBe(0);
  });

  it("returns an empty map for an absent feed", () => {
    expect(buildAwaitingCounts(undefined).size).toBe(0);
  });
});
