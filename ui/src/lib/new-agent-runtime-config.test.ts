// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";

describe("buildNewAgentRuntimeConfig", () => {
  it("defaults new agents to no timer heartbeat", () => {
    expect(buildNewAgentRuntimeConfig()).toEqual({
      heartbeat: {
        enabled: false,
        intervalSec: 300,
        wakeOnDemand: true,
        skipTimerWhenNoActionableWork: true,
        cooldownSec: 10,
        maxConcurrentRuns: AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
      },
    });
  });

  it("preserves explicit heartbeat settings", () => {
    expect(
      buildNewAgentRuntimeConfig({
        heartbeatEnabled: true,
        intervalSec: 3600,
      }),
    ).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: 3600,
        wakeOnDemand: true,
        skipTimerWhenNoActionableWork: true,
        cooldownSec: 10,
        maxConcurrentRuns: AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
      },
    });
  });

  it("omits activeHours by default", () => {
    expect(buildNewAgentRuntimeConfig({ heartbeatEnabled: true })).not.toHaveProperty(
      "heartbeat.activeHours",
    );
    expect(
      (buildNewAgentRuntimeConfig({ heartbeatEnabled: true }).heartbeat as Record<string, unknown>)
        .activeHours,
    ).toBeUndefined();
  });

  it("includes activeHours when the create form supplies it", () => {
    const window = { start: "09:00", end: "18:00", timezone: "America/New_York" };
    expect(
      buildNewAgentRuntimeConfig({
        heartbeatEnabled: true,
        intervalSec: 300,
        activeHours: window,
      }),
    ).toMatchObject({
      heartbeat: {
        enabled: true,
        activeHours: window,
      },
    });
  });

  it("does not persist activeHours when interval heartbeats are off", () => {
    expect(
      (
        buildNewAgentRuntimeConfig({
          heartbeatEnabled: false,
          activeHours: { start: "09:00", end: "18:00", timezone: "UTC" },
        }).heartbeat as Record<string, unknown>
      ).activeHours,
    ).toBeUndefined();
  });
});
