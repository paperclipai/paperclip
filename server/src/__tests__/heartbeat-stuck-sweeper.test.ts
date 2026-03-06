import { describe, expect, it } from "vitest";
import { decideStuckRunRecoveryAction, evaluateStuckRun } from "../services/heartbeat.js";

describe("evaluateStuckRun", () => {
  it("flags queued runs older than threshold", () => {
    const now = new Date("2026-03-05T12:00:00.000Z");
    const result = evaluateStuckRun({
      status: "queued",
      now,
      queuedReferenceAt: new Date("2026-03-05T11:20:00.000Z"),
      runningReferenceAt: null,
      thresholds: {
        queuedThresholdMs: 15 * 60 * 1000,
        runningNoProgressThresholdMs: 20 * 60 * 1000,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.reason).toBe("queued_stale");
    expect(result?.staleForMs).toBe(40 * 60 * 1000);
  });

  it("flags running runs with stale progress signals", () => {
    const now = new Date("2026-03-05T12:00:00.000Z");
    const result = evaluateStuckRun({
      status: "running",
      now,
      queuedReferenceAt: null,
      runningReferenceAt: new Date("2026-03-05T11:30:00.000Z"),
      thresholds: {
        queuedThresholdMs: 15 * 60 * 1000,
        runningNoProgressThresholdMs: 20 * 60 * 1000,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.reason).toBe("running_no_progress");
    expect(result?.staleForMs).toBe(30 * 60 * 1000);
  });
});

describe("decideStuckRunRecoveryAction", () => {
  it("chooses enqueue_recovery when under circuit-breaker limit", () => {
    const result = decideStuckRunRecoveryAction({
      recentAutoRequeues: 0,
      maxAutoRequeues: 2,
      hasPromotedDeferredRun: false,
    });

    expect(result).toEqual({
      action: "enqueue_recovery",
      nextAttempt: 1,
      circuitOpen: false,
    });
  });

  it("opens circuit breaker when retry limit is exceeded", () => {
    const result = decideStuckRunRecoveryAction({
      recentAutoRequeues: 2,
      maxAutoRequeues: 2,
      hasPromotedDeferredRun: false,
    });

    expect(result).toEqual({
      action: "circuit_open",
      nextAttempt: 3,
      circuitOpen: true,
    });
  });

  it("skips enqueue when deferred wake promotion already requeued work", () => {
    const result = decideStuckRunRecoveryAction({
      recentAutoRequeues: 0,
      maxAutoRequeues: 2,
      hasPromotedDeferredRun: true,
    });

    expect(result).toEqual({
      action: "already_requeued",
      nextAttempt: null,
      circuitOpen: false,
    });
  });
});
