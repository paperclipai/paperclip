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
        cooldownSec: 10,
        maxConcurrentRuns: AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
      },
    });
  });
});
