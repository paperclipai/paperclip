import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  buildUnsupportedModelProfileAdapterResult,
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
  it("uses the Codex local adapter cheap default when the agent has no runtime override", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: {
        model: "gpt-5.3-codex-spark",
        modelReasoningEffort: "high",
      },
    });
  });

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

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
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

  it("synthesizes a failed adapter result when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const result = buildUnsupportedModelProfileAdapterResult({
      adapterType: "grok_local",
      modelProfile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("model_profile_not_supported");
    expect(result.errorMessage).toMatch(/grok_local/);
    expect(result.errorMessage).toMatch(/cheap/);
    expect(result.errorMessage).toMatch(/no-op fallback/);
    expect(result.clearSession).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(result.errorMeta).toMatchObject({
      modelProfile: {
        requested: "cheap",
        applied: null,
        fallbackReason: "adapter_profile_not_supported",
      },
    });
    expect(result.resultJson).toMatchObject({
      modelProfile: {
        requested: "cheap",
        applied: null,
        fallbackReason: "adapter_profile_not_supported",
      },
    });
  });

  it("explains a runtime-disabled profile distinctly from a missing adapter profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: { enabled: false },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const result = buildUnsupportedModelProfileAdapterResult({
      adapterType: "codex_local",
      modelProfile,
    });

    expect(result.errorCode).toBe("model_profile_not_supported");
    expect(result.errorMessage).toMatch(/disabled/);
    expect(result.errorMessage).not.toMatch(/no-op fallback/);
    expect(result.errorMeta).toMatchObject({
      modelProfile: { fallbackReason: "agent_runtime_profile_disabled" },
    });
  });

  it("reproduces the CTO RUD-900 path: grok_local wake-context cheap request fails fast", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {},
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const result = buildUnsupportedModelProfileAdapterResult({
      adapterType: "grok_local",
      modelProfile,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: null,
      configSource: null,
      fallbackReason: "adapter_profile_not_supported",
    });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("model_profile_not_supported");
    expect(result.errorMessage).toMatch(/grok_local/);
    expect(result.errorMessage).toMatch(/cheap/);
    expect(result.clearSession).toBe(false);
    expect(result.errorMeta).toMatchObject({
      modelProfile: { requestedBy: "wake_context" },
    });
  });
});
