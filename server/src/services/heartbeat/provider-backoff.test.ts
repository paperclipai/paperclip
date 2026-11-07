import { describe, expect, it } from "vitest";
import {
  CODEX_PROVIDER_BACKOFF_DELAYS_MS,
  computeCodexProviderBackoffDelayMs,
  computeSnoozedTimerBaseline,
  evaluateCodexProviderBackoff,
  isCodexProviderBackoffFailure,
} from "./provider-backoff.js";

const now = new Date("2030-01-01T12:00:00.000Z");

function failedRun(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    agentId,
    status: "failed",
    error: "ChatGPT transport timed out",
    errorCode: "codex_transient_upstream",
    resultJson: { errorFamily: "transient_upstream" },
    ...overrides,
  };
}

describe("codex provider backoff", () => {
  it("counts transient upstream failures and ignores unrelated ones", () => {
    expect(isCodexProviderBackoffFailure(failedRun("a"))).toBe(true);
    expect(isCodexProviderBackoffFailure(failedRun("a", {
      errorCode: "adapter_failed",
      error: "stream disconnected: 429 Too Many Requests",
      resultJson: null,
    }))).toBe(true);
    expect(isCodexProviderBackoffFailure(failedRun("a", {
      errorCode: "adapter_failed",
      error: "workspace validation failed",
      resultJson: null,
    }))).toBe(false);
    expect(isCodexProviderBackoffFailure(failedRun("a", { status: "succeeded" }))).toBe(false);
  });

  it("stays closed until failures span enough runs and agents", () => {
    expect(evaluateCodexProviderBackoff([failedRun("a"), failedRun("b")], now)).toBeNull();
    expect(evaluateCodexProviderBackoff([failedRun("a"), failedRun("a"), failedRun("a")], now)).toBeNull();
  });

  it("opens with the base delay for a company-wide outage", () => {
    const gate = evaluateCodexProviderBackoff([failedRun("a"), failedRun("b"), failedRun("c")], now);
    expect(gate).toMatchObject({ failureCount: 3, affectedAgentCount: 3, retryNotBefore: null });
    expect(gate?.dueAt.getTime()).toBe(now.getTime() + CODEX_PROVIDER_BACKOFF_DELAYS_MS[0]);
  });

  it("waits for the latest provider retryNotBefore hint when it is later", () => {
    const hint = new Date(now.getTime() + 30 * 60_000);
    const gate = evaluateCodexProviderBackoff([
      failedRun("a"),
      failedRun("b", { resultJson: { errorFamily: "transient_upstream", retryNotBefore: hint.toISOString() } }),
      failedRun("c", { resultJson: { errorFamily: "transient_upstream", retryNotBefore: "2020-01-01T00:00:00.000Z" } }),
    ], now);
    expect(gate?.retryNotBefore?.toISOString()).toBe(hint.toISOString());
    expect(gate?.dueAt.toISOString()).toBe(hint.toISOString());
  });

  it("grows the delay with the failure count and caps it", () => {
    expect(computeCodexProviderBackoffDelayMs(3)).toBe(CODEX_PROVIDER_BACKOFF_DELAYS_MS[0]);
    expect(computeCodexProviderBackoffDelayMs(6)).toBe(CODEX_PROVIDER_BACKOFF_DELAYS_MS[1]);
    expect(computeCodexProviderBackoffDelayMs(50)).toBe(CODEX_PROVIDER_BACKOFF_DELAYS_MS.at(-1));
  });

  it("moves the timer baseline so the next tick lands at the end of the window", () => {
    const gate = evaluateCodexProviderBackoff([failedRun("a"), failedRun("b"), failedRun("c")], now)!;
    const baseline = computeSnoozedTimerBaseline({ gate, intervalSec: 60, now });
    expect(baseline.getTime() + 60_000).toBe(gate.dueAt.getTime());
    expect(computeSnoozedTimerBaseline({ gate, intervalSec: 3600, now }).getTime()).toBe(now.getTime());
  });
});
