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

  it("stores cheap model under modelProfiles.cheap, not primary adapterConfig", () => {
    const config = buildNewAgentRuntimeConfig({
      heartbeatEnabled: true,
      intervalSec: 600,
      cheapModel: "claude-sonnet-4-6",
      cheapModelEnabled: true,
    });

    expect(config.modelProfiles).toEqual({
      cheap: {
        enabled: true,
        adapterConfig: { model: "claude-sonnet-4-6" },
      },
    });
    // primary heartbeat config still present
    expect(config.heartbeat).toMatchObject({ enabled: true, intervalSec: 600 });
  });

  it("omits modelProfiles when no cheap model is configured", () => {
    const config = buildNewAgentRuntimeConfig({ heartbeatEnabled: false });
    expect(config.modelProfiles).toBeUndefined();
  });

  it("omits modelProfiles when cheap model is set but explicitly disabled", () => {
    const config = buildNewAgentRuntimeConfig({
      cheapModel: "claude-sonnet-4-6",
      cheapModelEnabled: false,
    });
    expect(config.modelProfiles).toBeUndefined();
  });
});
