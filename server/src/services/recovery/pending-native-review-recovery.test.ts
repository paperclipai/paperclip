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

describe("decidePendingNativeReview", () => {
  it("leaves a review alone while a review run or wake is live", () => {
    expect(decidePendingNativeReview({ interactionCreatedAt: created, now: at(60 * minute), hasPendingWake: false,
      reviewRuns: [{ status: "running", createdAt: at(minute), finishedAt: null }] })).toEqual({ kind: "active" });
    expect(decidePendingNativeReview({ interactionCreatedAt: created, now: at(60 * minute), hasPendingWake: true,
      reviewRuns: [] })).toEqual({ kind: "active" });
  });

  it("waits for the grace period after the last review run finished", () => {
    expect(decidePendingNativeReview({ interactionCreatedAt: created, now: at(5 * minute), hasPendingWake: false,
      reviewRuns: [finishedRun(2 * minute)] }))
      .toEqual({ kind: "wait", until: at(2 * minute + NATIVE_REVIEW_IDLE_GRACE_MS).getTime() });
  });

  it("re-wakes the reviewer when a finished review run left the review pending", () => {
    expect(decidePendingNativeReview({ interactionCreatedAt: created, now: at(16 * 60 * minute), hasPendingWake: false,
      reviewRuns: [finishedRun(2 * minute)] })).toEqual({ kind: "rewake", attempt: 2 });
  });

  it("re-wakes the reviewer when its first wake never produced a run", () => {
    expect(decidePendingNativeReview({ interactionCreatedAt: created, now: at(30 * minute), hasPendingWake: false,
      reviewRuns: [] })).toEqual({ kind: "rewake", attempt: 1 });
  });

  it("escalates once every review attempt is spent", () => {
    expect(decidePendingNativeReview({ interactionCreatedAt: created, now: at(120 * minute), hasPendingWake: false,
      reviewRuns: [finishedRun(2 * minute), finishedRun(20 * minute), finishedRun(40 * minute)] }))
      .toEqual({ kind: "escalate", attempts: 3 });
  });
});

describe("pendingNativeReviewEscalationBody", () => {
  it("names the reviewer and both review choices", () => {
    const body = pendingNativeReviewEscalationBody({ reviewerName: "Eindbaas", attempts: 3 });
    expect(body).toContain("Eindbaas was asked 3 times");
    expect(body).toContain("Approve completion");
    expect(body).toContain("Continue work");
  });
});
