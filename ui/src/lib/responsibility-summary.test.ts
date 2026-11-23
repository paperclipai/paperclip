import { afterEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_REFRESH_DELAYS_MS, summaryAttribution, summaryRefetchDelay } from "./responsibility-summary";

afterEach(() => vi.useRealTimers());

describe("summaryRefetchDelay", () => {
  it("reads again on a backoff only while a model-written version is on its way", () => {
    expect(summaryRefetchDelay({ refreshing: true }, 1)).toBe(2_000);
    expect(summaryRefetchDelay({ refreshing: true }, 2)).toBe(3_000);
    expect(summaryRefetchDelay({ refreshing: false }, 1)).toBe(false);
    expect(summaryRefetchDelay(undefined, 0)).toBe(false);
  });

  it("stops once the waits are used up, so it never polls forever", () => {
    const reads = SUMMARY_REFRESH_DELAYS_MS.length;
    expect(summaryRefetchDelay({ refreshing: true }, reads)).toBe(SUMMARY_REFRESH_DELAYS_MS.at(-1));
    expect(summaryRefetchDelay({ refreshing: true }, reads + 1)).toBe(false);
    expect(SUMMARY_REFRESH_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(60_000);
  });
});

describe("summaryAttribution", () => {
  it("never calls a computed paragraph AI-written, and says when it was written", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    expect(summaryAttribution({ source: "computed", generatedAt: "2026-11-13T12:00:00Z", refreshing: false }, false)).toEqual({
      source: "Summarized from the numbers",
      when: "just now",
      pending: null,
    });
    expect(summaryAttribution({ source: "model", generatedAt: "2026-11-13T11:55:00Z", refreshing: false }, false)).toEqual({
      source: "Written by AI",
      when: "5m ago",
      pending: null,
    });
  });

  it("says an AI version is coming only while the page is still waiting for it", () => {
    const computed = { source: "computed" as const, generatedAt: new Date().toISOString(), refreshing: true };
    expect(summaryAttribution(computed, true).pending).toBe("AI summary on the way");
    expect(summaryAttribution(computed, false).pending).toBeNull();
    expect(summaryAttribution({ ...computed, source: "model" }, true).pending).toBeNull();
  });
});
