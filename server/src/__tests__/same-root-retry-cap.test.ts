import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_RETRY_LINEAGE_WAKE_REASONS,
  SAME_ROOT_AUTOMATIC_RETRY_BACKOFF_MS,
  SAME_ROOT_AUTOMATIC_RETRY_JITTER_RATIO,
  SAME_ROOT_AUTOMATIC_RETRY_MAX_RETRIES,
  SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS,
  SAME_ROOT_AUTOMATIC_RETRY_MIN_DELAY_MS,
  buildSameRootRetryPark,
  computeSameRootRetryDelayMs,
  evaluateSameRootRetry,
  isEpochAdvancingWakeReason,
  resolveRetryEpochForNewRun,
  resolveRetryRootRunId,
} from "../services/same-root-retry-cap.ts";

describe("resolveRetryRootRunId", () => {
  it("uses the source's own id when it is the first run of a lineage", () => {
    expect(resolveRetryRootRunId({ id: "run-a", retryRootRunId: null, retryEpoch: null })).toBe("run-a");
  });

  it("propagates an existing root unchanged so fresh run ids cannot escape it", () => {
    expect(resolveRetryRootRunId({ id: "run-b", retryRootRunId: "run-a", retryEpoch: 0 })).toBe("run-a");
  });
});

describe("isEpochAdvancingWakeReason", () => {
  it("keeps recovery-internal reasons on the same epoch", () => {
    for (const reason of AUTOMATIC_RETRY_LINEAGE_WAKE_REASONS) {
      expect(isEpochAdvancingWakeReason(reason)).toBe(false);
    }
  });

  it("advances the epoch for new external input", () => {
    for (const reason of [
      "issue_commented",
      "issue_status_changed",
      "issue_reopened",
      "issue_children_changed",
      "issue_blockers_resolved",
      "issue_comment_mentioned",
      "issue_monitor_due",
      "issue_assigned",
      "manual_retry",
    ]) {
      expect(isEpochAdvancingWakeReason(reason)).toBe(true);
    }
  });

  it("treats an unknown reason as new input (fail open to resume, not to loop)", () => {
    expect(isEpochAdvancingWakeReason("some_future_reason")).toBe(true);
  });

  it("does not advance on a missing reason", () => {
    expect(isEpochAdvancingWakeReason(null)).toBe(false);
    expect(isEpochAdvancingWakeReason(undefined)).toBe(false);
  });
});

describe("resolveRetryEpochForNewRun", () => {
  const source = { id: "run-a", retryRootRunId: null, retryEpoch: 2 };

  it("continues the source epoch for a recovery-internal wake", () => {
    expect(resolveRetryEpochForNewRun({ source, wakeReason: "process_lost_retry" })).toBe(2);
    expect(resolveRetryEpochForNewRun({ source, wakeReason: "issue_continuation_needed" })).toBe(2);
  });

  it("advances the epoch for new external input", () => {
    expect(resolveRetryEpochForNewRun({ source, wakeReason: "issue_commented" })).toBe(3);
  });

  it("treats a missing source epoch as 0", () => {
    const fresh = { id: "run-a", retryRootRunId: null, retryEpoch: null };
    expect(resolveRetryEpochForNewRun({ source: fresh, wakeReason: "process_lost_retry" })).toBe(0);
    expect(resolveRetryEpochForNewRun({ source: fresh, wakeReason: "issue_commented" })).toBe(1);
  });
});

describe("evaluateSameRootRetry", () => {
  it("allows the first, second, and third retry (first run + 3 = 4 total)", () => {
    for (let priorRuns = 1; priorRuns <= SAME_ROOT_AUTOMATIC_RETRY_MAX_RETRIES; priorRuns += 1) {
      const decision = evaluateSameRootRetry({ priorAutomaticRunCount: priorRuns });
      expect(decision).toEqual({
        allowed: true,
        attempt: priorRuns,
        maxRetries: SAME_ROOT_AUTOMATIC_RETRY_MAX_RETRIES,
      });
    }
  });

  it("parks the 4th retry — no 5th run for the same root/epoch", () => {
    const decision = evaluateSameRootRetry({ priorAutomaticRunCount: SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS });
    expect(decision).toEqual({
      allowed: false,
      outcome: "root_retry_cap_exhausted",
      attempt: SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS,
      maxRetries: SAME_ROOT_AUTOMATIC_RETRY_MAX_RETRIES,
    });
  });

  it("stops a 144-run same-root failure chain within 4 total runs", () => {
    // Replay of the runaway chain this cap targets: a root that keeps failing and
    // being recovered. Count the automatic runs that would actually be created.
    let automaticRunsCreated = 1; // the first (root) run
    for (let i = 0; i < 144; i += 1) {
      const decision = evaluateSameRootRetry({ priorAutomaticRunCount: automaticRunsCreated });
      if (!decision.allowed) break;
      automaticRunsCreated += 1;
    }
    expect(automaticRunsCreated).toBe(SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS);
    expect(automaticRunsCreated).toBeLessThanOrEqual(4);
  });

  it("resumes with a clean budget after the epoch advances", () => {
    // Same root, new epoch (e.g. a human comment): the per-epoch count resets.
    const resumed = evaluateSameRootRetry({ priorAutomaticRunCount: 1 });
    expect(resumed.allowed).toBe(true);
    expect(resumed.attempt).toBe(1);
  });

  it("honors a caller-supplied lower cap", () => {
    expect(evaluateSameRootRetry({ priorAutomaticRunCount: 1, maxRetries: 0 }).allowed).toBe(false);
    expect(evaluateSameRootRetry({ priorAutomaticRunCount: 1, maxRetries: 1 }).allowed).toBe(true);
    expect(evaluateSameRootRetry({ priorAutomaticRunCount: 2, maxRetries: 1 }).allowed).toBe(false);
  });
});

describe("computeSameRootRetryDelayMs", () => {
  it("returns the ladder base delay when jitter is neutral", () => {
    SAME_ROOT_AUTOMATIC_RETRY_BACKOFF_MS.forEach((base, index) => {
      expect(computeSameRootRetryDelayMs(index + 1, () => 0.5)).toBe(base);
    });
  });

  it("grows monotonically across attempts (exponential backoff)", () => {
    const delays = SAME_ROOT_AUTOMATIC_RETRY_BACKOFF_MS.map((_base, index) =>
      computeSameRootRetryDelayMs(index + 1, () => 0.5),
    );
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("keeps every delay inside the ±25% jitter band", () => {
    SAME_ROOT_AUTOMATIC_RETRY_BACKOFF_MS.forEach((base, index) => {
      const attempt = index + 1;
      const low = computeSameRootRetryDelayMs(attempt, () => 0);
      const high = computeSameRootRetryDelayMs(attempt, () => 1);
      expect(low).toBe(Math.round(base * (1 - SAME_ROOT_AUTOMATIC_RETRY_JITTER_RATIO)));
      expect(high).toBe(Math.round(base * (1 + SAME_ROOT_AUTOMATIC_RETRY_JITTER_RATIO)));
      // random() is clamped to [0,1], so the band is a hard range.
      for (const sample of [0, 0.1, 0.37, 0.5, 0.83, 1]) {
        const delay = computeSameRootRetryDelayMs(attempt, () => sample);
        expect(delay).toBeGreaterThanOrEqual(low);
        expect(delay).toBeLessThanOrEqual(high);
      }
    });
  });

  it("reuses the last rung for attempts past the ladder and never returns below the floor", () => {
    const lastBase = SAME_ROOT_AUTOMATIC_RETRY_BACKOFF_MS[SAME_ROOT_AUTOMATIC_RETRY_BACKOFF_MS.length - 1];
    expect(computeSameRootRetryDelayMs(99, () => 0.5)).toBe(lastBase);
    expect(computeSameRootRetryDelayMs(1, () => 0)).toBeGreaterThanOrEqual(SAME_ROOT_AUTOMATIC_RETRY_MIN_DELAY_MS);
  });
});

describe("buildSameRootRetryPark", () => {
  it("captures the last failure and a resumable next action for the operator", () => {
    const park = buildSameRootRetryPark({
      rootRunId: "run-a",
      epoch: 0,
      attempt: 4,
      maxRetries: 3,
      lastErrorCode: "adapter_failed",
      lastErrorMessage: "Configured model is unavailable",
      nextOwner: "user-owner",
    });
    expect(park.status).toBe("parked");
    expect(park.reason).toBe("root_retry_cap_exhausted");
    expect(park.rootRunId).toBe("run-a");
    expect(park.nextOwner).toBe("user-owner");
    expect(park.summary).toContain("adapter_failed");
    expect(park.summary).toContain("Configured model is unavailable");
    expect(park.nextAction).toMatch(/resume/i);
  });

  it("degrades gracefully when no error detail is available", () => {
    const park = buildSameRootRetryPark({
      rootRunId: "run-a",
      epoch: 1,
      attempt: 4,
      maxRetries: 3,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextOwner: null,
    });
    expect(park.summary).toContain("unknown failure");
  });
});
