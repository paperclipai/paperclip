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
});
