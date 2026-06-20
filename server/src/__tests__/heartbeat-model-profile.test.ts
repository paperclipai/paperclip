import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
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
});

describe("model profile env deep-merge", () => {
  it("merges profile env into base env key-by-key (base keys preserved, profile keys override)", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [
        {
          key: "bulk",
          label: "Workers AI",
          adapterConfig: {
            model: "@cf/moonshotai/kimi-k2.7-code",
            env: { OPENAI_BASE_URL: "https://cf/ai/v1" },
          },
          source: "adapter_default",
        },
      ],
      agentRuntimeConfig: {},
      issueModelProfile: "bulk",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "openai/gpt-5.4",
        env: { OPENAI_API_KEY: "agent-key", PATH_HINT: "keepme" },
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(merged.model).toBe("@cf/moonshotai/kimi-k2.7-code");
    expect(merged.env).toEqual({
      OPENAI_API_KEY: "agent-key", // base key preserved
      PATH_HINT: "keepme", // base key preserved
      OPENAI_BASE_URL: "https://cf/ai/v1", // profile key added
    });
  });

  it("lets a secret_ref env binding from a profile survive the merge", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [
        {
          key: "bulk",
          label: "Workers AI",
          adapterConfig: {
            env: {
              OPENAI_API_KEY: { type: "secret_ref", secretId: "cf-token" },
            },
          },
          source: "adapter_default",
        },
      ],
      agentRuntimeConfig: {},
      issueModelProfile: "bulk",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { env: { OPENAI_API_KEY: "agent-plain" } },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(merged.env).toEqual({
      OPENAI_API_KEY: { type: "secret_ref", secretId: "cf-token" },
    });
  });

  it("issue adapter env overrides profile env which overrides base env", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [
        { key: "bulk", label: "B", adapterConfig: { env: { K: "from-profile" } }, source: "adapter_default" },
      ],
      agentRuntimeConfig: {},
      issueModelProfile: "bulk",
      contextSnapshot: {},
    });
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { env: { K: "from-base", B: "base-only" } },
      modelProfile,
      issueAdapterConfig: { env: { K: "from-issue" } },
    });
    expect(merged.env).toEqual({ K: "from-issue", B: "base-only" });
  });
});
