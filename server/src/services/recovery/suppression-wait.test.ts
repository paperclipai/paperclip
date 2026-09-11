import { describe, expect, it } from "vitest";
import {
  buildSuppressedWakeParkMarker,
  readSuppressedWakeParkMarker,
  rearmSuppressedWakeParkMarker,
} from "./suppression-wait.js";

const context = (marker: unknown) => ({ suppressedWakePark: marker });

describe("suppressed wake park markers", () => {
  it("round-trips a dependency park marker", () => {
    const marker = buildSuppressedWakeParkMarker({
      cause: "issue_dependencies_blocked",
      now: new Date("2026-09-11T10:00:00.000Z"),
      unresolvedBlockerIssueIds: ["blocker-1"],
      wakeReason: "issue_continuation_needed",
    });
    expect(readSuppressedWakeParkMarker(context(marker))).toEqual(marker);
    expect(marker.suppressions).toBe(1);
    expect(marker.rechecks).toBe(0);
    expect(marker.wakeReason).toBe("issue_continuation_needed");
    expect(marker.schedulingReason).toBeNull();
  });

  it("refreshes re-derivations while keeping the original park anchor and identity", () => {
    const first = buildSuppressedWakeParkMarker({
      cause: "issue_dependencies_blocked",
      now: new Date("2026-09-11T10:00:00.000Z"),
      unresolvedBlockerIssueIds: ["blocker-1"],
      wakeReason: "issue_continuation_needed",
    });
    const refreshed = buildSuppressedWakeParkMarker({
      cause: "issue_dependencies_blocked",
      now: new Date("2026-09-11T10:05:00.000Z"),
      unresolvedBlockerIssueIds: ["blocker-1", "blocker-2"],
      wakeReason: "issue_continuation_needed",
      previous: first,
    });
    expect(refreshed.cause).toBe(first.cause);
    expect(refreshed.parkedAt).toBe(first.parkedAt);
    expect(refreshed.wakeReason).toBe(first.wakeReason);
    expect(refreshed.suppressions).toBe(2);
    expect(refreshed.lastSuppressedAt).toBe("2026-09-11T10:05:00.000Z");
    expect(refreshed.unresolvedBlockerIssueIds).toEqual(["blocker-1", "blocker-2"]);
  });

  it("records the scheduling reason and keeps it across refreshes", () => {
    const first = buildSuppressedWakeParkMarker({
      cause: "scheduling_suppressed",
      now: new Date("2026-09-11T10:00:00.000Z"),
      schedulingReason: "task_drain",
      wakeReason: "interaction_pending",
    });
    const refreshed = buildSuppressedWakeParkMarker({
      cause: "scheduling_suppressed",
      now: new Date("2026-09-11T10:01:00.000Z"),
      schedulingReason: "task_drain",
      wakeReason: "interaction_pending",
      previous: first,
    });
    expect(refreshed.cause).toBe("scheduling_suppressed");
    expect(refreshed.schedulingReason).toBe("task_drain");
    expect(refreshed.wakeReason).toBe("interaction_pending");
    expect(refreshed.suppressions).toBe(2);
    expect(readSuppressedWakeParkMarker(context(refreshed))?.parkedAt).toBe(
      "2026-09-11T10:00:00.000Z",
    );
  });

  it("bumps only the recheck counter on an in-place re-arm", () => {
    const parked = buildSuppressedWakeParkMarker({
      cause: "issue_dependencies_blocked",
      now: new Date("2026-09-11T10:00:00.000Z"),
      unresolvedBlockerIssueIds: ["blocker-1"],
      wakeReason: "issue_continuation_needed",
    });
    const rearmed = rearmSuppressedWakeParkMarker(
      parked,
      new Date("2026-09-11T10:02:00.000Z"),
    );
    expect(rearmed.rechecks).toBe(1);
    expect(rearmed.suppressions).toBe(parked.suppressions);
    expect(rearmed.parkedAt).toBe(parked.parkedAt);
    expect(rearmed.unresolvedBlockerIssueIds).toEqual(parked.unresolvedBlockerIssueIds);
  });

  it("rejects malformed markers instead of inventing park state", () => {
    expect(readSuppressedWakeParkMarker(null)).toBeNull();
    expect(readSuppressedWakeParkMarker("nope")).toBeNull();
    expect(readSuppressedWakeParkMarker({ suppressedWakePark: {} })).toBeNull();
    expect(readSuppressedWakeParkMarker({ suppressedWakePark: { cause: "other", parkedAt: "x" } })).toBeNull();
    expect(
      readSuppressedWakeParkMarker({
        suppressedWakePark: { cause: "issue_dependencies_blocked", parkedAt: 5 },
      }),
    ).toBeNull();
  });
});
