import { describe, expect, it } from "vitest";
import { describeHeartbeatInvokeResponse } from "./heartbeat-invoke-feedback";

describe("describeHeartbeatInvokeResponse", () => {
  it("returns a run outcome when the invoke response contains a run id", () => {
    const result = describeHeartbeatInvokeResponse({
      id: "run-1",
    });

    expect(result).toEqual({
      kind: "run",
      runId: "run-1",
    });
  });

  it("returns a helpful skipped message when the server omits one", () => {
    const result = describeHeartbeatInvokeResponse({
      status: "skipped",
      reason: "heartbeat.live_run_limit_reached",
    });

    expect(result).toEqual({
      kind: "skipped",
      message: "Heartbeat was skipped because this agent already has live work in flight.",
    });
  });
});
