import { describe, expect, it } from "vitest";

import { resolveHeartbeatRunOutcome } from "../services/heartbeat.ts";

describe("heartbeat run outcome finalization", () => {
  it("succeeds for exit 0 terminal completion after the linked issue is done", () => {
    expect(
      resolveHeartbeatRunOutcome({
        latestStatus: "running",
        timedOut: false,
        exitCode: 0,
        signal: null,
        errorMessage: null,
      }),
    ).toBe("succeeded");
  });

  it("preserves genuine structured failure metadata", () => {
    expect(
      resolveHeartbeatRunOutcome({
        latestStatus: "running",
        timedOut: false,
        exitCode: 0,
        signal: null,
        errorMessage: "provider unavailable",
      }),
    ).toBe("failed");
  });

  it("returns timed_out when the adapter timed out", () => {
    expect(
      resolveHeartbeatRunOutcome({
        latestStatus: "running",
        timedOut: true,
        exitCode: 0,
        signal: null,
        errorMessage: null,
      }),
    ).toBe("timed_out");
  });

  it("returns failed when the process was signaled", () => {
    expect(
      resolveHeartbeatRunOutcome({
        latestStatus: "running",
        timedOut: false,
        exitCode: 0,
        signal: "SIGTERM",
        errorMessage: null,
      }),
    ).toBe("failed");
  });

  it("passes through an already-terminal latestStatus", () => {
    expect(
      resolveHeartbeatRunOutcome({
        latestStatus: "cancelled",
        timedOut: false,
        exitCode: 0,
        signal: null,
        errorMessage: null,
      }),
    ).toBe("cancelled");
  });

  it("treats null exitCode as failure (consistent with execute.ts)", () => {
    expect(
      resolveHeartbeatRunOutcome({
        latestStatus: "running",
        timedOut: false,
        exitCode: null,
        signal: null,
        errorMessage: null,
      }),
    ).toBe("failed");
  });
});
