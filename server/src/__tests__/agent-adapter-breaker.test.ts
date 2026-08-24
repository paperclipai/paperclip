import { describe, expect, it } from "vitest";
import {
  ADAPTER_BREAKER_BASE_SUSPENSION_MS,
  ADAPTER_BREAKER_CHAIN_GAP_MS,
  ADAPTER_BREAKER_MAX_SUSPENSION_MS,
  computeAdapterBreakerSuspension,
} from "../services/agent-adapter-breaker.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function minutesAgoRun(minutesAgo: number, errorCode: string | null, status = "failed") {
  return {
    status,
    errorCode,
    finishedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  };
}

describe("computeAdapterBreakerSuspension", () => {
  it("returns no suspension without failures", () => {
    expect(computeAdapterBreakerSuspension([], NOW)).toEqual({
      suspendedUntil: null,
      consecutiveFailures: 0,
    });
  });

  it("does not suspend below the consecutive-failure threshold", () => {
    const runs = [
      minutesAgoRun(5, "adapter_failed"),
      minutesAgoRun(12, "adapter_failed"),
    ];
    const result = computeAdapterBreakerSuspension(runs, NOW);
    expect(result.suspendedUntil).toBeNull();
    expect(result.consecutiveFailures).toBe(2);
  });

  it("suspends with base window after three chained failures", () => {
    const runs = [
      minutesAgoRun(5, "adapter_failed"),
      minutesAgoRun(11, "timeout"),
      minutesAgoRun(18, "provider_quota"),
    ];
    const result = computeAdapterBreakerSuspension(runs, NOW);
    expect(result.consecutiveFailures).toBe(3);
    expect(result.suspendedUntil?.getTime()).toBe(
      NOW.getTime() - 5 * 60_000 + ADAPTER_BREAKER_BASE_SUSPENSION_MS,
    );
  });

  it("resets the chain when failures are spread wider than the chain gap", () => {
    const runs = [
      minutesAgoRun(5, "adapter_failed"),
      minutesAgoRun(40, "adapter_failed"),
      minutesAgoRun(75, "adapter_failed"),
    ];
    const result = computeAdapterBreakerSuspension(runs, NOW);
    expect(result.suspendedUntil).toBeNull();
    expect(result.consecutiveFailures).toBe(1);
  });

  it("breaks the chain on an intervening successful run", () => {
    const runs = [
      minutesAgoRun(5, "adapter_failed"),
      minutesAgoRun(11, "adapter_failed"),
      minutesAgoRun(16, null, "succeeded"),
      minutesAgoRun(22, "adapter_failed"),
    ];
    const result = computeAdapterBreakerSuspension(runs, NOW);
    expect(result.suspendedUntil).toBeNull();
    expect(result.consecutiveFailures).toBe(2);
  });

  it("escalates the window exponentially and caps it", () => {
    const four = [
      minutesAgoRun(5, "adapter_failed"),
      minutesAgoRun(9, "adapter_failed"),
      minutesAgoRun(14, "adapter_failed"),
      minutesAgoRun(19, "adapter_failed"),
    ];
    const resultFour = computeAdapterBreakerSuspension(four, NOW);
    expect(resultFour.consecutiveFailures).toBe(4);
    expect(resultFour.suspendedUntil?.getTime()).toBe(
      NOW.getTime() - 5 * 60_000 + 2 * ADAPTER_BREAKER_BASE_SUSPENSION_MS,
    );

    const five = [...four, minutesAgoRun(25, "adapter_failed")];
    const resultFive = computeAdapterBreakerSuspension(five, NOW);
    expect(resultFive.consecutiveFailures).toBe(5);
    expect(resultFive.suspendedUntil?.getTime()).toBe(
      NOW.getTime() - 5 * 60_000 + ADAPTER_BREAKER_MAX_SUSPENSION_MS,
    );
  });

  it("treats an already-expired suspension window as open", () => {
    const runs = [
      minutesAgoRun(90, "adapter_failed"),
      minutesAgoRun(96, "adapter_failed"),
      minutesAgoRun(102, "adapter_failed"),
    ];
    const result = computeAdapterBreakerSuspension(runs, NOW);
    expect(result.suspendedUntil).toBeNull();
    expect(result.consecutiveFailures).toBe(3);
  });

  it("ignores runs without a breaker-class error code while keeping chain continuity", () => {
    const runs = [
      minutesAgoRun(5, "adapter_failed"),
      minutesAgoRun(9, "some_unrelated_error"),
      minutesAgoRun(13, "claude_transient_upstream"),
      minutesAgoRun(17, "codex_transient_upstream"),
    ];
    const result = computeAdapterBreakerSuspension(runs, NOW);
    expect(result.consecutiveFailures).toBe(3);
    expect(result.suspendedUntil?.getTime()).toBe(
      NOW.getTime() - 5 * 60_000 + ADAPTER_BREAKER_BASE_SUSPENSION_MS,
    );
  });
});
