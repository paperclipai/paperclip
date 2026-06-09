import { describe, expect, it } from "vitest";
import {
  USAGE_LIMIT_HEARTBEAT_RETRY_DELAY_MS,
  computeUsageLimitHeartbeatRetrySchedule,
  isUsageLimitErrorText,
  isUsageLimitHeartbeatRun,
} from "./heartbeat.js";

describe("usage limit heartbeat retry", () => {
  it("detects the provider usage-limit text without adapter-specific metadata", () => {
    expect(isUsageLimitErrorText("You've hit your usage limit")).toBe(true);
    expect(isUsageLimitErrorText("adapter failed: you’ve hit your usage limit, try later")).toBe(true);
    expect(isUsageLimitHeartbeatRun({
      error: null,
      errorCode: "adapter_failed",
      resultJson: {
        stderr: "OpenAI: You've hit your usage limit",
      },
    })).toBe(true);
  });

  it("does not classify ordinary errors as usage limits", () => {
    expect(isUsageLimitErrorText("rate limit exceeded")).toBe(false);
    expect(isUsageLimitHeartbeatRun({
      error: "adapter failed",
      errorCode: "adapter_failed",
      resultJson: {
        stderr: "network timeout",
      },
    })).toBe(false);
  });

  it("schedules bounded retries after the five-hour reset window", () => {
    const now = new Date("2026-06-09T00:00:00.000Z");
    const first = computeUsageLimitHeartbeatRetrySchedule(1, now);

    expect(first).toEqual({
      attempt: 1,
      baseDelayMs: USAGE_LIMIT_HEARTBEAT_RETRY_DELAY_MS,
      delayMs: USAGE_LIMIT_HEARTBEAT_RETRY_DELAY_MS,
      dueAt: new Date("2026-06-09T05:00:00.000Z"),
      maxAttempts: 3,
    });
    expect(computeUsageLimitHeartbeatRetrySchedule(4, now)).toBeNull();
  });
});
