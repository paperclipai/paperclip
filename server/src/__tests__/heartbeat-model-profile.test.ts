import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  computeStrongFailoverForce,
  hasInactiveForcedModelProfile,
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  readActiveForcedModelProfile,
  resolveModelProfileApplication,
  isConfigurationIncompleteFailedRun,
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
  it("keeps Codex on its primary model when cheap has no explicit model override", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary" },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: {},
      adapterConfig: {
        model: "gpt-5.4",
        modelReasoningEffort: "medium",
      },
    });
    expect(merged).toEqual({ model: "primary" });
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

  it("treats model resolution failures as non-retryable configuration failures", () => {
    expect(isConfigurationIncompleteFailedRun({ errorCode: "model_not_found" })).toBe(true);
    expect(isConfigurationIncompleteFailedRun({ errorCode: "provider_quota" })).toBe(false);
  });

  it("resolves the codex_local strong profile to gpt-5.4/medium", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "strong",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({
      requested: "strong",
      requestedBy: "issue_override",
      applied: "strong",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: { model: "gpt-5.4", modelReasoningEffort: "medium" },
    });
  });

  it("an active forced profile overrides the issue/context request (limit failover)", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: { modelProfile: "cheap" },
      forcedProfile: "strong",
    });

    expect(modelProfile).toMatchObject({
      requested: "strong",
      requestedBy: "limit_failover_force",
      applied: "strong",
      adapterConfig: { model: "gpt-5.4", modelReasoningEffort: "medium" },
    });
  });
});

describe("readActiveForcedModelProfile (limit-failover swap-back)", () => {
  const now = new Date("2026-06-16T12:00:00.000Z");

  it("returns the forced profile while the force is still active", () => {
    const rc = { modelProfileForce: { profile: "strong", until: "2026-06-16T13:00:00.000Z" } };
    expect(readActiveForcedModelProfile(rc, now)).toBe("strong");
    expect(hasInactiveForcedModelProfile(rc, now)).toBe(false);
  });

  it("returns null and reports inactive once the force has expired (swap-back)", () => {
    const rc = { modelProfileForce: { profile: "strong", until: "2026-06-16T11:00:00.000Z" } };
    expect(readActiveForcedModelProfile(rc, now)).toBeNull();
    expect(hasInactiveForcedModelProfile(rc, now)).toBe(true);
  });

  it("ignores an unknown forced profile key", () => {
    const rc = { modelProfileForce: { profile: "turbo", until: "2026-06-16T13:00:00.000Z" } };
    expect(readActiveForcedModelProfile(rc, now)).toBeNull();
  });

  it("returns null (and reports active=false) when no force is set", () => {
    expect(readActiveForcedModelProfile({}, now)).toBeNull();
    expect(hasInactiveForcedModelProfile({}, now)).toBe(false);
  });
});

describe("computeStrongFailoverForce (codex usage-limit trigger)", () => {
  const now = new Date("2026-06-16T12:00:00.000Z");
  const futureReset = "2026-06-16T13:00:00.000Z";

  it("promotes to strong until the reset when no force is set", () => {
    expect(computeStrongFailoverForce({}, futureReset, now)).toEqual({ profile: "strong", until: futureReset });
  });

  it("accepts a Date reset", () => {
    expect(computeStrongFailoverForce({}, new Date(futureReset), now)).toEqual({ profile: "strong", until: futureReset });
  });

  it("no-ops when the reset is in the past or invalid", () => {
    expect(computeStrongFailoverForce({}, "2026-06-16T11:00:00.000Z", now)).toBeNull();
    expect(computeStrongFailoverForce({}, "not-a-date", now)).toBeNull();
    expect(computeStrongFailoverForce({}, null, now)).toBeNull();
  });

  it("does not shorten an existing strong force that already extends past the reset", () => {
    const rc = { modelProfileForce: { profile: "strong", until: "2026-06-16T14:00:00.000Z" } };
    expect(computeStrongFailoverForce(rc, futureReset, now)).toBeNull();
  });

  it("extends an existing strong force when the new reset is later", () => {
    const rc = { modelProfileForce: { profile: "strong", until: "2026-06-16T12:30:00.000Z" } };
    expect(computeStrongFailoverForce(rc, futureReset, now)).toEqual({ profile: "strong", until: futureReset });
  });
});
