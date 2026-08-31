import { describe, expect, it } from "vitest";
import {
  compareQueuedRunPickup,
  type QueuedRunPickupCandidate,
} from "../services/heartbeat.ts";

function candidate(overrides: Partial<QueuedRunPickupCandidate> = {}): QueuedRunPickupCandidate {
  return {
    createdAtMs: 0,
    hasIssue: true,
    isDependencyReady: true,
    issueStatus: "in_progress",
    issuePriority: "medium",
    executionState: null,
    ...overrides,
  };
}

const reworkState: Record<string, unknown> = { status: "changes_requested" };

/** Sort a copy the same way startNextQueuedRunForAgent does, returning labels. */
function pickupOrder(items: Array<{ label: string; candidate: QueuedRunPickupCandidate }>): string[] {
  return [...items]
    .sort((left, right) => compareQueuedRunPickup(left.candidate, right.candidate))
    .map((item) => item.label);
}

describe("compareQueuedRunPickup", () => {
  it("picks a reviewer-reworked issue before an older same-priority in_progress peer", () => {
    // Regression for the FIFO gap: rework carries the newest createdAt, so
    // without the rework tiebreaker the older peer would win.
    const order = pickupOrder([
      { label: "peer", candidate: candidate({ createdAtMs: 1_000 }) },
      { label: "rework", candidate: candidate({ createdAtMs: 5_000, executionState: reworkState }) },
    ]);
    expect(order).toEqual(["rework", "peer"]);
  });

  it("keeps the reviewer-rework boost above issue priority", () => {
    // A human change-request is the highest-signal instruction: act on it next,
    // even ahead of a higher-priority peer at the same status.
    const order = pickupOrder([
      { label: "critical", candidate: candidate({ issuePriority: "critical" }) },
      { label: "rework", candidate: candidate({ issuePriority: "medium", executionState: reworkState }) },
    ]);
    expect(order).toEqual(["rework", "critical"]);
  });

  it("never lets the rework boost outrank dependency/status readiness", () => {
    // A dependency-blocked rework (rank 3) still yields to a ready peer (rank 1).
    const order = pickupOrder([
      { label: "blockedRework", candidate: candidate({ isDependencyReady: false, executionState: reworkState }) },
      { label: "ready", candidate: candidate({ issueStatus: "todo" }) },
    ]);
    expect(order).toEqual(["ready", "blockedRework"]);
  });

  it("leaves non-rework ordering unchanged (priority then FIFO)", () => {
    const order = pickupOrder([
      { label: "medOld", candidate: candidate({ issuePriority: "medium", createdAtMs: 1_000 }) },
      { label: "high", candidate: candidate({ issuePriority: "high", createdAtMs: 9_000 }) },
      { label: "medNew", candidate: candidate({ issuePriority: "medium", createdAtMs: 2_000 }) },
    ]);
    expect(order).toEqual(["high", "medOld", "medNew"]);
  });

  it("treats a resubmitted issue (marker cleared) as an ordinary run again", () => {
    // Once resubmitted the executionState.status is no longer changes_requested,
    // so the boost is gone and FIFO decides between equal peers.
    const order = pickupOrder([
      { label: "older", candidate: candidate({ createdAtMs: 1_000, executionState: { status: "pending" } }) },
      { label: "newer", candidate: candidate({ createdAtMs: 2_000, executionState: { status: "pending" } }) },
    ]);
    expect(order).toEqual(["older", "newer"]);
  });
});
