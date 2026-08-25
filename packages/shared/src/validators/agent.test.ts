import { describe, expect, it } from "vitest";
import {
  agentRuntimeConfigSchema,
  updateAgentSchema,
} from "./agent.js";

describe("agentRuntimeConfigSchema", () => {
  it("accepts a disabled cheap profile with no adapterConfig", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      modelProfiles: {
        cheap: { enabled: false },
      },
    });

    expect(parsed.modelProfiles?.cheap).toEqual({ enabled: false });
  });

  it("accepts a cheap profile adapterConfig object and still validates env bindings", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      heartbeat: { intervalSec: 30 },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: {
            model: "gpt-5.3-codex-spark",
            env: {
              API_TOKEN: "plain-token",
            },
          },
        },
      },
    });

    expect(parsed.modelProfiles?.cheap?.adapterConfig).toEqual({
      model: "gpt-5.3-codex-spark",
      env: {
        API_TOKEN: "plain-token",
      },
    });
    expect(parsed.heartbeat).toEqual({ intervalSec: 30 });
  });

  it("rejects a cheap profile adapterConfig that is not an object", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: "not-an-object",
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects invalid env bindings when adapterConfig is present", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        cheap: {
          adapterConfig: {
            env: {
              API_TOKEN: 123,
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown keys on a cheap model profile", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        cheap: {
          enabled: false,
          unknownKey: true,
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("updateAgentSchema", () => {
  it("accepts a disabled cheap profile with no adapterConfig", () => {
    const parsed = updateAgentSchema.parse({
      runtimeConfig: {
        heartbeat: { intervalSec: 45 },
        modelProfiles: {
          cheap: { enabled: false },
        },
      },
    });

    expect(parsed.runtimeConfig?.modelProfiles?.cheap).toEqual({ enabled: false });
    expect(parsed.runtimeConfig?.heartbeat).toEqual({ intervalSec: 45 });
  });
});
