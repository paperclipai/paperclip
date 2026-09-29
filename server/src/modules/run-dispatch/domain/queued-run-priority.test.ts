import { describe, expect, it } from "vitest";
import {
  QUEUE_PRIORITY_AGE_STEP_MS,
  agedPriorityRank,
  allowsTerminalStatusBypass,
  compareQueuedRunClaimOrder,
  issueRunPriorityRank,
  queueWaitStartedAt,
} from "./queued-run-priority.js";

describe("issueRunPriorityRank", () => {
  it.each([
    ["critical", 0],
    ["high", 1],
    ["medium", 2],
    ["low", 3],
    [null, 4],
    [undefined, 4],
    ["unknown", 4],
  ] as const)("%s → %s", (priority, rank) => {
    expect(issueRunPriorityRank(priority)).toBe(rank);
  });
});

describe("queueWaitStartedAt", () => {
  const createdAt = new Date("2026-09-17T06:00:00.000Z");
  const updatedAt = new Date("2026-09-17T12:00:00.000Z");

  it("uses createdAt for a never-retried wake", () => {
    expect(
      queueWaitStartedAt({
        createdAt,
        updatedAt,
        scheduledRetryAt: null,
      }),
    ).toEqual(createdAt);
  });

  it("uses updatedAt after a scheduled-retry promotion (not original createdAt)", () => {
    // promoteDueRetryInTx bumps updatedAt at promotion; createdAt stays old.
    expect(
      queueWaitStartedAt({
        createdAt,
        updatedAt,
        scheduledRetryAt: new Date("2026-09-17T06:05:00.000Z"),
      }),
    ).toEqual(updatedAt);
  });
});

describe("agedPriorityRank", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");

  it("matches the base rank when the wake is fresh", () => {
    expect(
      agedPriorityRank("low", new Date("2026-09-17T11:59:00.000Z"), now),
    ).toBe(3);
  });

  it("promotes low by one step after one age window (external: 2h step)", () => {
    // Would fail against a no-aging comparator that always returns base 3.
    expect(
      agedPriorityRank(
        "low",
        new Date(now.getTime() - QUEUE_PRIORITY_AGE_STEP_MS),
        now,
      ),
    ).toBe(2);
  });

  it("lets a 6h-old low sort ahead of a fresh medium", () => {
    const agedLow = agedPriorityRank(
      "low",
      new Date(now.getTime() - 3 * QUEUE_PRIORITY_AGE_STEP_MS),
      now,
    );
    const freshMedium = agedPriorityRank(
      "medium",
      new Date(now.getTime() - 60_000),
      now,
    );
    expect(agedLow).toBe(0);
    expect(freshMedium).toBe(2);
    expect(agedLow).toBeLessThan(freshMedium);
  });

  it("caps aging so low cannot climb past critical-equivalent", () => {
    expect(
      agedPriorityRank(
        "low",
        new Date(now.getTime() - 10 * QUEUE_PRIORITY_AGE_STEP_MS),
        now,
      ),
    ).toBe(0);
  });

  it("does not let a 2h-old low overtake a fresh high", () => {
    const agedLow = agedPriorityRank(
      "low",
      new Date(now.getTime() - QUEUE_PRIORITY_AGE_STEP_MS),
      now,
    );
    const freshHigh = agedPriorityRank("high", now, now);
    expect(agedLow).toBe(2);
    expect(freshHigh).toBe(1);
    expect(agedLow).toBeGreaterThan(freshHigh);
  });
});

describe("compareQueuedRunClaimOrder", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const sixHoursAgo = new Date(now.getTime() - 3 * QUEUE_PRIORITY_AGE_STEP_MS);

  it("lets a low that actually waited 6h in-queue beat a fresh medium at the same readiness rank", () => {
    const waitedLow = {
      readinessRank: 1,
      priority: "low" as const,
      queueWaitStartedAt: sixHoursAgo,
    };
    const freshMedium = {
      readinessRank: 1,
      priority: "medium" as const,
      queueWaitStartedAt: now,
    };
    expect(compareQueuedRunClaimOrder(waitedLow, freshMedium, now)).toBeLessThan(
      0,
    );
  });

  it("does not let a freshly-promoted retry inherit pre-queue delay over a fresh higher-priority wake", () => {
    // Fails if aging uses original createdAt (sixHoursAgo) instead of queue-wait
    // start (now). Same readiness rank; retry was scheduled_retry for 6h then
    // promoted just now.
    const promotedLowRetry = {
      readinessRank: 1,
      priority: "low" as const,
      queueWaitStartedAt: queueWaitStartedAt({
        createdAt: sixHoursAgo,
        updatedAt: now,
        scheduledRetryAt: sixHoursAgo,
      }),
    };
    const freshMedium = {
      readinessRank: 1,
      priority: "medium" as const,
      queueWaitStartedAt: queueWaitStartedAt({
        createdAt: now,
        updatedAt: now,
        scheduledRetryAt: null,
      }),
    };
    expect(promotedLowRetry.queueWaitStartedAt).toEqual(now);
    expect(
      compareQueuedRunClaimOrder(promotedLowRetry, freshMedium, now),
    ).toBeGreaterThan(0);

    // Document the defect the old createdAt clock would produce:
    const wronglyAged = {
      ...promotedLowRetry,
      queueWaitStartedAt: sixHoursAgo,
    };
    expect(compareQueuedRunClaimOrder(wronglyAged, freshMedium, now)).toBeLessThan(
      0,
    );
  });

  it("never lets aging overtake a lower readiness rank (in_progress still wins)", () => {
    const agedLowReady = {
      readinessRank: 1,
      priority: "low" as const,
      queueWaitStartedAt: sixHoursAgo,
    };
    const freshInProgress = {
      readinessRank: 0,
      priority: "low" as const,
      queueWaitStartedAt: now,
    };
    expect(
      compareQueuedRunClaimOrder(agedLowReady, freshInProgress, now),
    ).toBeGreaterThan(0);
  });
});

describe("allowsTerminalStatusBypass", () => {
  it("keeps resume intent on a terminal issue", () => {
    expect(
      allowsTerminalStatusBypass({
        resumeIntent: true,
        wakeCommentIdPresent: false,
        wakeReason: "issue_assigned",
      }),
    ).toBe(true);
  });

  it("rejects a bare comment id on an assignment wake (fails on old wakeCommentId-only rule)", () => {
    expect(
      allowsTerminalStatusBypass({
        resumeIntent: false,
        wakeCommentIdPresent: true,
        wakeReason: "issue_assigned",
      }),
    ).toBe(false);
  });

  it("rejects execution_review_requested even when a comment id is present", () => {
    expect(
      allowsTerminalStatusBypass({
        resumeIntent: false,
        wakeCommentIdPresent: true,
        wakeReason: "execution_review_requested",
      }),
    ).toBe(false);
  });

  it("keeps issue_comment_mentioned when a comment id is present", () => {
    expect(
      allowsTerminalStatusBypass({
        resumeIntent: false,
        wakeCommentIdPresent: true,
        wakeReason: "issue_comment_mentioned",
      }),
    ).toBe(true);
  });

  it("rejects a comment id with a null wake reason", () => {
    expect(
      allowsTerminalStatusBypass({
        resumeIntent: false,
        wakeCommentIdPresent: true,
        wakeReason: null,
      }),
    ).toBe(false);
  });
});
