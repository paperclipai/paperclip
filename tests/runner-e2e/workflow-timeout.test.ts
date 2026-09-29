import { describe, expect, it, vi } from "vitest";
import { pollUntil } from "./api.js";
import { classifyFailure } from "./failure-classifier.js";
import { storyHasDurableAgentReviewContinuation, storyHasStrandedBlockedLeaf, storyReviewContinuationTimeoutDetail, type StoryIssue } from "./everyday-observations.js";

describe("workflow timeout classification", () => {
  it("does not classify observed task data as an infrastructure error", async () => {
    vi.useFakeTimers();
    try {
      const pending = pollUntil({
        label: "everyday hire-reuse settled",
        deadlineAt: Date.now() + 10,
        intervalMs: 10,
        load: async () => ({
          status: "in_progress",
          connection: "server unavailable",
          secret: "plaintext in an ordinary task description",
        }),
        accept: () => false,
      });
      const caught = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(11);
      const error = await caught;
      expect(classifyFailure(error)).toBe("candidate_failure");
      expect((error as Error).message).not.toContain(
        "ordinary task description",
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a failed network read retryable", async () => {
    vi.useFakeTimers();
    try {
      const caught = pollUntil({
        label: "task state",
        deadlineAt: Date.now() + 10,
        intervalMs: 10,
        load: async () => {
          throw new Error("ECONNRESET");
        },
        accept: () => false,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(11);
      expect(classifyFailure(await caught)).toBe("transient_infrastructure");
    } finally {
      vi.useRealTimers();
    }
  });
});


describe("review continuation deadline", () => {
  function fixture(now: number) {
    const issues: StoryIssue[] = [
      { id: "parent", companyId: "company", title: "parent", status: "blocked", blockedTransitionAt: new Date(now - 1000).toISOString() },
      { id: "child", parentId: "parent", companyId: "company", title: "child", status: "done", interactions: [{
        id: "review", issueId: "child", kind: "request_confirmation", status: "accepted",
        addresseeAgentId: "lead", resolvedByAgentId: "lead", resolvedByRunId: "review-run",
        resolvedAt: new Date(now).toISOString(), result: { version: 1, outcome: "accepted" },
        payload: { target: { type: "custom", key: "native_completion_review", revisionId: "decision" } },
      }] },
    ];
    const runs = [{ id: "review-run", companyId: "company", agentId: "lead", status: "succeeded", finishedAt: new Date(now).toISOString() }];
    return { issues, runs };
  }

  it("uses the review timeout detail only with stranded work and durable review evidence", () => {
    const state = fixture(Date.now());
    expect(
      storyReviewContinuationTimeoutDetail(state.issues, "parent", "lead", state.runs, ["lead"]),
    ).toBe("task is Blocked without an active continuation after accepted review");
    state.issues[1]!.interactions = [];
    expect(
      storyReviewContinuationTimeoutDetail(state.issues, "parent", "lead", state.runs, ["lead"]),
    ).toBeUndefined();
    const completed = fixture(Date.now());
    completed.issues[0]!.status = "done";
    expect(
      storyReviewContinuationTimeoutDetail(
        completed.issues, "parent", "lead", completed.runs, ["lead"],
      ),
    ).toBeUndefined();
  });

  it("permits a delayed parent continuation within the existing deadline", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const state = fixture(start);
      const pending = pollUntil({
        label: "review handoff", deadlineAt: start + 30_000, intervalMs: 1000,
        load: async () => {
          if (Date.now() >= start + 20_000) state.issues[0]!.status = "done";
          return state;
        },
        accept: ({ issues }) => issues.every((issue) => issue.status === "done"),
        reject: ({ issues, runs }) => storyHasStrandedBlockedLeaf(issues, "lead") &&
          !storyHasDurableAgentReviewContinuation(issues, "parent", "lead", runs)
          ? "task is Blocked without an active continuation" : undefined,
      });
      const caught = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20_001);
      expect(await caught).toBe(state);
    } finally { vi.useRealTimers(); }
  });

  it("reports a missing wake specifically when the existing deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const state = fixture(Date.now());
      const pending = pollUntil({
        label: "review handoff", deadlineAt: Date.now() + 30_000, intervalMs: 1000,
        load: async () => state, accept: () => false,
        timeoutDetail: (last) => last && storyReviewContinuationTimeoutDetail(
          last.issues, "parent", "lead", last.runs, ["lead"],
        ),
      });
      const caught = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_001);
      const error = await caught;
      expect((error as Error).message).toContain("Blocked without an active continuation after accepted review");
      expect(classifyFailure(error)).toBe("candidate_failure");
    } finally { vi.useRealTimers(); }
  });

  it("uses the generic timeout when durable review evidence is absent", async () => {
    vi.useFakeTimers();
    try {
      const state = fixture(Date.now());
      state.issues[1]!.interactions = [];
      const pending = pollUntil({
        label: "review handoff", deadlineAt: Date.now() + 30_000, intervalMs: 1000,
        load: async () => state, accept: () => false,
        timeoutDetail: (last) => last && storyReviewContinuationTimeoutDetail(
          last.issues, "parent", "lead", last.runs, ["lead"],
        ),
      });
      const caught = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_001);
      const error = await caught;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("after accepted review");
      expect(classifyFailure(error)).toBe("candidate_failure");
    } finally { vi.useRealTimers(); }
  });
});
