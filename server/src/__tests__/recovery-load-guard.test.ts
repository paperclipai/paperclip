import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECOVERY_API_LATENCY_WINDOW_MS,
  DEFAULT_RECOVERY_API_P50_THRESHOLD_MS,
  DEFAULT_RECOVERY_LOAD_REFUSAL_RATIO,
  evaluateRecoveryLoadGate,
  resolveRecoveryLoadThresholds,
  ApiLatencyTracker,
} from "../services/recovery/load-guard.js";

describe("evaluateRecoveryLoadGate", () => {
  const thresholds = { loadRefusalRatio: 1.25, apiP50ThresholdMs: 5_000 };

  it("admits dispatch when host load and API latency are both healthy", () => {
    const decision = evaluateRecoveryLoadGate({
      hostLoad: { loadAverage1m: 2, cpuCount: 12 },
      apiP50Ms: 200,
      thresholds,
    });
    expect(decision).toMatchObject({ deferred: false, reason: null });
  });

  it("defers on host load exceeding the refusal ratio (RBR-977 measured: 52.40 on 12 cores)", () => {
    const decision = evaluateRecoveryLoadGate({
      hostLoad: { loadAverage1m: 52.4, cpuCount: 12 },
      apiP50Ms: null,
      thresholds,
    });
    expect(decision.deferred).toBe(true);
    expect(decision.reason).toBe("host_load");
  });

  it("defers on API p50 exceeding threshold even when host load is healthy", () => {
    const decision = evaluateRecoveryLoadGate({
      hostLoad: { loadAverage1m: 1, cpuCount: 12 },
      apiP50Ms: 101_400, // RBR-977 measured a single POST at 101.4s
      thresholds,
    });
    expect(decision.deferred).toBe(true);
    expect(decision.reason).toBe("api_latency");
  });

  it("does not defer on latency alone when there is no sample (null is 'unknown', not 'degraded')", () => {
    const decision = evaluateRecoveryLoadGate({
      hostLoad: { loadAverage1m: 1, cpuCount: 12 },
      apiP50Ms: null,
      thresholds,
    });
    expect(decision.deferred).toBe(false);
  });

  it("prefers the host-load reason over latency when both are over threshold", () => {
    const decision = evaluateRecoveryLoadGate({
      hostLoad: { loadAverage1m: 52.4, cpuCount: 12 },
      apiP50Ms: 101_400,
      thresholds,
    });
    expect(decision.reason).toBe("host_load");
  });
});

describe("resolveRecoveryLoadThresholds", () => {
  it("uses defaults when env and overrides are absent", () => {
    const thresholds = resolveRecoveryLoadThresholds({});
    expect(thresholds).toEqual({
      loadRefusalRatio: DEFAULT_RECOVERY_LOAD_REFUSAL_RATIO,
      apiP50ThresholdMs: DEFAULT_RECOVERY_API_P50_THRESHOLD_MS,
      apiLatencyWindowMs: DEFAULT_RECOVERY_API_LATENCY_WINDOW_MS,
    });
  });

  it("is configurable via env vars", () => {
    const thresholds = resolveRecoveryLoadThresholds({
      PAPERCLIP_RECOVERY_LOAD_REFUSAL_RATIO: "2.5",
      PAPERCLIP_RECOVERY_API_P50_THRESHOLD_MS: "9000",
      PAPERCLIP_RECOVERY_API_P50_WINDOW_MS: "60000",
    });
    expect(thresholds).toEqual({ loadRefusalRatio: 2.5, apiP50ThresholdMs: 9_000, apiLatencyWindowMs: 60_000 });
  });

  it("prefers explicit overrides over env vars", () => {
    const thresholds = resolveRecoveryLoadThresholds(
      { PAPERCLIP_RECOVERY_LOAD_REFUSAL_RATIO: "2.5" },
      { loadRefusalRatio: 9 },
    );
    expect(thresholds.loadRefusalRatio).toBe(9);
  });

  it("falls back to defaults on invalid/non-positive env values", () => {
    const thresholds = resolveRecoveryLoadThresholds({
      PAPERCLIP_RECOVERY_LOAD_REFUSAL_RATIO: "not-a-number",
      PAPERCLIP_RECOVERY_API_P50_THRESHOLD_MS: "-100",
    });
    expect(thresholds).toEqual({
      loadRefusalRatio: DEFAULT_RECOVERY_LOAD_REFUSAL_RATIO,
      apiP50ThresholdMs: DEFAULT_RECOVERY_API_P50_THRESHOLD_MS,
      apiLatencyWindowMs: DEFAULT_RECOVERY_API_LATENCY_WINDOW_MS,
    });
  });
});

describe("ApiLatencyTracker", () => {
  it("returns null p50 when there are no samples (unknown, not healthy)", () => {
    const tracker = new ApiLatencyTracker();
    expect(tracker.getP50()).toBeNull();
  });

  it("computes p50 over recorded samples", () => {
    const tracker = new ApiLatencyTracker();
    for (const ms of [100, 200, 300, 400, 500]) tracker.record(ms, 1_000);
    expect(tracker.getP50(undefined, 1_000)).toBe(300);
  });

  it("excludes samples outside the requested window", () => {
    const tracker = new ApiLatencyTracker();
    tracker.record(100, 0);
    tracker.record(101_400, 10_000); // RBR-977's measured slow POST
    expect(tracker.getP50(5_000, 10_000)).toBe(101_400);
    expect(tracker.getP50(5_000, 100_000)).toBeNull();
  });

  it("ignores non-finite or negative durations", () => {
    const tracker = new ApiLatencyTracker();
    tracker.record(Number.NaN, 0);
    tracker.record(-5, 0);
    expect(tracker.getP50(undefined, 1_000)).toBeNull();
  });
});
