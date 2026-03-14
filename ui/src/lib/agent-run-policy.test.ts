import { describe, expect, it } from "vitest";
import { getAgentRunPolicy } from "./agent-run-policy";

describe("getAgentRunPolicy", () => {
  it("uses the same defaults as the server heartbeat policy", () => {
    expect(getAgentRunPolicy({})).toEqual({
      heartbeatEnabled: true,
      intervalSec: 0,
      wakeOnDemand: true,
      hasTimerHeartbeat: false,
    });
  });

  it("treats a positive interval as a timer heartbeat only when enabled", () => {
    expect(
      getAgentRunPolicy({
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          wakeOnDemand: false,
        },
      }),
    ).toEqual({
      heartbeatEnabled: true,
      intervalSec: 300,
      wakeOnDemand: false,
      hasTimerHeartbeat: true,
    });

    expect(
      getAgentRunPolicy({
        heartbeat: {
          enabled: false,
          intervalSec: 300,
        },
      }),
    ).toEqual({
      heartbeatEnabled: false,
      intervalSec: 300,
      wakeOnDemand: true,
      hasTimerHeartbeat: false,
    });
  });

  it("supports the legacy wake-on-demand keys the server still accepts", () => {
    expect(
      getAgentRunPolicy({
        heartbeat: {
          wakeOnAssignment: false,
        },
      }),
    ).toEqual({
      heartbeatEnabled: true,
      intervalSec: 0,
      wakeOnDemand: false,
      hasTimerHeartbeat: false,
    });
  });
});
