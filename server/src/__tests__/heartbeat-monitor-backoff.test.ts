import { describe, expect, it } from "vitest";
import { computeIssueMonitorFailedDispatchBackoffDelayMs } from "../services/heartbeat.js";

describe("computeIssueMonitorFailedDispatchBackoffDelayMs", () => {
  it("keeps a one-off failure at the 150s base delay", () => {
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(1)).toBe(150_000);
  });

  it("escalates a sustained burst above the base delay up to the one-hour cap", () => {
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(2)).toBe(300_000);
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(8)).toBe(3_600_000);
  });
});
