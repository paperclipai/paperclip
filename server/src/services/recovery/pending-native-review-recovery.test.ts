import { describe, expect, it } from "vitest";
import {
  decidePendingNativeReview,
  NATIVE_REVIEW_IDLE_GRACE_MS,
  pendingNativeReviewEscalationBody,
} from "./pending-native-review-recovery.js";

const minute = 60_000;
const created = new Date("2026-11-12T14:25:00Z");
const at = (offsetMs: number) => new Date(created.getTime() + offsetMs);
const finishedRun = (offsetMs: number) => ({ status: "succeeded", createdAt: at(offsetMs - minute), finishedAt: at(offsetMs) });
const base = { interactionCreatedAt: created, hasPendingWake: false, reviewerCanResolve: true, recoveryWakes: [] as Array<{ createdAt: Date }> };

describe("decidePendingNativeReview", () => {
  it("leaves a review alone while a review run or wake is live", () => {
    expect(decidePendingNativeReview({ ...base, now: at(60 * minute),
      reviewRuns: [{ status: "running", createdAt: at(minute), finishedAt: null }] })).toEqual({ kind: "active" });
    expect(decidePendingNativeReview({ ...base, now: at(60 * minute), hasPendingWake: true, reviewRuns: [] }))
      .toEqual({ kind: "active" });
  });

  it("waits for the grace period after the last review run finished", () => {
    expect(decidePendingNativeReview({ ...base, now: at(5 * minute), reviewRuns: [finishedRun(2 * minute)] }))
      .toEqual({ kind: "wait", until: at(2 * minute + NATIVE_REVIEW_IDLE_GRACE_MS).getTime() });
  });

  it("re-wakes the reviewer when a finished review run left the review pending", () => {
    expect(decidePendingNativeReview({ ...base, now: at(16 * 60 * minute), reviewRuns: [finishedRun(2 * minute)] }))
      .toEqual({ kind: "rewake", attempt: 2 });
  });

  it("re-wakes the reviewer when its first wake never produced a run", () => {
    expect(decidePendingNativeReview({ ...base, now: at(30 * minute), reviewRuns: [] }))
      .toEqual({ kind: "rewake", attempt: 2 });
  });

  it("counts a refused recovery wake as an attempt and waits after it", () => {
    const refused = [{ createdAt: at(60 * minute) }];
    expect(decidePendingNativeReview({ ...base, now: at(61 * minute), reviewRuns: [], recoveryWakes: refused }))
      .toEqual({ kind: "wait", until: at(60 * minute + NATIVE_REVIEW_IDLE_GRACE_MS).getTime() });
    expect(decidePendingNativeReview({ ...base, now: at(90 * minute), reviewRuns: [], recoveryWakes: refused }))
      .toEqual({ kind: "rewake", attempt: 3 });
    expect(decidePendingNativeReview({ ...base, now: at(200 * minute), reviewRuns: [],
      recoveryWakes: [...refused, { createdAt: at(100 * minute) }] }))
      .toEqual({ kind: "escalate", attempts: 3, reason: "attempts_spent" });
  });

  it("escalates once every review attempt is spent", () => {
    expect(decidePendingNativeReview({ ...base, now: at(120 * minute),
      reviewRuns: [finishedRun(2 * minute), finishedRun(20 * minute), finishedRun(40 * minute)] }))
      .toEqual({ kind: "escalate", attempts: 3, reason: "attempts_spent" });
  });

  it("escalates at once when the reviewer can no longer resolve the review", () => {
    expect(decidePendingNativeReview({ ...base, now: at(minute), reviewerCanResolve: false, reviewRuns: [] }))
      .toEqual({ kind: "escalate", attempts: 1, reason: "reviewer_unavailable" });
  });
});

describe("pendingNativeReviewEscalationBody", () => {
  it("names the reviewer and both review choices", () => {
    const body = pendingNativeReviewEscalationBody({ reviewerName: "Eindbaas", attempts: 3, reason: "attempts_spent" });
    expect(body).toContain("Eindbaas was asked 3 times");
    expect(body).toContain("Approve completion");
    expect(body).toContain("Continue work");
  });

  it("explains a reviewer that can no longer resolve the review", () => {
    expect(pendingNativeReviewEscalationBody({ reviewerName: "Darth Coder", attempts: 2, reason: "reviewer_unavailable" }))
      .toContain("Darth Coder can no longer resolve this review");
  });
});
