import { describe, expect, it } from "vitest";
import type { AdapterModelProfileDefinition } from "../adapters/index.js";
import {
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
  sanitizeIssueAssigneeAdapterConfigForAdapter,
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

  it("preserves the agent base model over a profile model when no issue-level override is set", () => {
    // Regression: cheap profile used to override adapterConfig.model with a stale/deprecated
    // model (e.g. openai/gpt-5.1-codex-mini), causing runtime failures for agents that had
    // explicitly configured a different model (e.g. lmstudio/meta/llama-3.3-70b).
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "lmstudio/meta/llama-3.3-70b",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    // Base model must win; only non-model profile fields (e.g. modelReasoningEffort) are merged.
    expect(merged.model).toBe("lmstudio/meta/llama-3.3-70b");
    expect(merged.modelReasoningEffort).toBe("low");
    expect(merged.approvalPolicy).toBe("strict");
  });

  it("lets an explicit issue-level model override the agent base model even with a cheap profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "lmstudio/meta/llama-3.3-70b",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "openai/gpt-5.2",
      },
    });

    expect(merged.model).toBe("openai/gpt-5.2");
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });

  it("strips a stale issue-level model override that the assigned adapter does not support", () => {
    const sanitized = sanitizeIssueAssigneeAdapterConfigForAdapter({
      adapterType: "codex_local",
      issueAdapterConfig: {
        model: "claude-opus-4-6",
        modelReasoningEffort: "high",
      },
      adapterModels: [
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.4", label: "GPT-5.4" },
      ],
    });

    expect(sanitized.adapterConfig).toEqual({
      modelReasoningEffort: "high",
    });
    expect(sanitized.warnings).toEqual([
      'Ignoring issue-level model override "claude-opus-4-6" because adapter "codex_local" does not support it.',
    ]);
  });

  it("preserves a supported issue-level model override", () => {
    const sanitized = sanitizeIssueAssigneeAdapterConfigForAdapter({
      adapterType: "codex_local",
      issueAdapterConfig: {
        model: "gpt-5.5",
        modelReasoningEffort: "high",
      },
      adapterModels: [
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.4", label: "GPT-5.4" },
      ],
    });

    expect(sanitized.adapterConfig).toEqual({
      model: "gpt-5.5",
      modelReasoningEffort: "high",
    });
    expect(sanitized.warnings).toEqual([]);
  });
});
