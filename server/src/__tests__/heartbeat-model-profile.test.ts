import { describe, expect, it } from "vitest";
import type { AdapterModelProfileDefinition } from "../adapters/index.js";
import {
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
} from "../services/heartbeat.ts";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when neither adapter nor runtime defines the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {}, // no modelProfiles configured in runtime either
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });

  it("applies an agent-runtime-only cheap profile when the adapter declares none (lmstudio)", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [], // plugin adapter => no registry profiles
      agentRuntimeConfig: {
        modelProfiles: { cheap: { enabled: true, adapterConfig: { model: "gemma-4-31b-it-mlx" } } },
      },
      issueModelProfile: null,
      contextSnapshot: {},
      routerModelProfile: "cheap",
      routerReason: "short_non_substantive",
    });
    expect(modelProfile.applied).toBe("cheap");
    expect(modelProfile.requestedBy).toBe("auto_router");
    expect(modelProfile.routerReason).toBe("short_non_substantive");
    expect(modelProfile.configSource).toBe("agent_runtime");
    expect(modelProfile.adapterConfig).toMatchObject({ model: "gemma-4-31b-it-mlx" });
  });

  it("lets an explicit issue override win over the router decision", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: { cheap: { enabled: true, adapterConfig: { model: "gemma-4-31b-it-mlx" } } },
      },
      issueModelProfile: "cheap",
      contextSnapshot: {},
      routerModelProfile: "cheap",
      routerReason: "short_non_substantive",
    });
    expect(modelProfile.requestedBy).toBe("issue_override");
    expect(modelProfile.routerReason).toBeNull();
  });
});
