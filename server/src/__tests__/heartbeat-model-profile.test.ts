import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
  isConfigurationIncompleteFailedRun,
  isIssueAutonomousWork,
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

  describe("agent_autonomous_default source (BRO-2637)", () => {
    const optedInRuntimeConfig = {
      modelProfiles: {
        cheap: {
          applyToAutonomousWork: true,
          adapterConfig: {
            model: "agent-cheap",
          },
        },
      },
    };

    it("computes autonomous work as no human-created issue and no human comment", () => {
      expect(isIssueAutonomousWork({ createdByUserId: null, hasUserComment: false })).toBe(true);
      expect(isIssueAutonomousWork({ createdByUserId: undefined, hasUserComment: false })).toBe(true);
      expect(isIssueAutonomousWork({ createdByUserId: "user-1", hasUserComment: false })).toBe(false);
      expect(isIssueAutonomousWork({ createdByUserId: null, hasUserComment: true })).toBe(false);
      expect(isIssueAutonomousWork({ createdByUserId: "user-1", hasUserComment: true })).toBe(false);
    });

    it("applies the cheap profile for an opted-in agent on an agent-created issue with no user comments", () => {
      const modelProfile = resolveModelProfileApplication({
        adapterModelProfiles: [cheapProfile],
        agentRuntimeConfig: optedInRuntimeConfig,
        issueModelProfile: null,
        contextSnapshot: {},
        isAutonomousWork: isIssueAutonomousWork({ createdByUserId: null, hasUserComment: false }),
      });

      expect(modelProfile).toMatchObject({
        requested: "cheap",
        requestedBy: "agent_autonomous_default",
        applied: "cheap",
        configSource: "agent_runtime",
        fallbackReason: null,
        adapterConfig: {
          model: "agent-cheap",
          modelReasoningEffort: "low",
        },
      });
    });

    it("does not apply the cheap profile for an opted-in agent on a human-created issue", () => {
      const modelProfile = resolveModelProfileApplication({
        adapterModelProfiles: [cheapProfile],
        agentRuntimeConfig: optedInRuntimeConfig,
        issueModelProfile: null,
        contextSnapshot: {},
        isAutonomousWork: isIssueAutonomousWork({ createdByUserId: "human-user-1", hasUserComment: false }),
      });

      expect(modelProfile).toMatchObject({
        requested: null,
        requestedBy: null,
        applied: null,
        configSource: null,
        fallbackReason: null,
        adapterConfig: null,
      });
    });

    it("does not apply the cheap profile once a human has commented on an agent-created issue", () => {
      const modelProfile = resolveModelProfileApplication({
        adapterModelProfiles: [cheapProfile],
        agentRuntimeConfig: optedInRuntimeConfig,
        issueModelProfile: null,
        contextSnapshot: {},
        isAutonomousWork: isIssueAutonomousWork({ createdByUserId: null, hasUserComment: true }),
      });

      expect(modelProfile).toMatchObject({
        requested: null,
        requestedBy: null,
        applied: null,
        configSource: null,
        fallbackReason: null,
        adapterConfig: null,
      });
    });

    it("lets an explicit per-issue adapterConfig override win over the autonomous default", () => {
      const modelProfile = resolveModelProfileApplication({
        adapterModelProfiles: [cheapProfile],
        agentRuntimeConfig: optedInRuntimeConfig,
        issueModelProfile: null,
        contextSnapshot: {},
        isAutonomousWork: true,
      });

      const merged = mergeModelProfileAdapterConfig({
        baseConfig: { model: "primary", modelReasoningEffort: "high" },
        modelProfile,
        issueAdapterConfig: { model: "issue-explicit" },
      });

      expect(modelProfile.requestedBy).toBe("agent_autonomous_default");
      expect(merged).toEqual({
        model: "issue-explicit",
        modelReasoningEffort: "low",
      });
    });

    it("explicit issue-level modelProfile still wins precedence over the autonomous default", () => {
      const modelProfile = resolveModelProfileApplication({
        adapterModelProfiles: [cheapProfile],
        agentRuntimeConfig: optedInRuntimeConfig,
        issueModelProfile: "cheap",
        contextSnapshot: {},
        isAutonomousWork: true,
      });

      expect(modelProfile.requestedBy).toBe("issue_override");
    });

    it("wake-context modelProfile still wins precedence over the autonomous default", () => {
      const modelProfile = resolveModelProfileApplication({
        adapterModelProfiles: [cheapProfile],
        agentRuntimeConfig: optedInRuntimeConfig,
        issueModelProfile: null,
        contextSnapshot: { modelProfile: "cheap" },
        isAutonomousWork: true,
      });

      expect(modelProfile.requestedBy).toBe("wake_context");
    });

    it("is byte-identical to today's behaviour when applyToAutonomousWork is absent or false", () => {
      const absentConfig = { modelProfiles: { cheap: { adapterConfig: { model: "agent-cheap" } } } };
      const falseConfig = {
        modelProfiles: { cheap: { applyToAutonomousWork: false, adapterConfig: { model: "agent-cheap" } } },
      };

      for (const agentRuntimeConfig of [absentConfig, falseConfig, {}]) {
        const modelProfile = resolveModelProfileApplication({
          adapterModelProfiles: [cheapProfile],
          agentRuntimeConfig,
          issueModelProfile: null,
          contextSnapshot: {},
          isAutonomousWork: true,
        });

        expect(modelProfile).toMatchObject({
          requested: null,
          requestedBy: null,
          applied: null,
        });
      }

      // Callers that don't pass isAutonomousWork at all (pre-existing call sites) are unaffected.
      const modelProfileNoFlag = resolveModelProfileApplication({
        adapterModelProfiles: [cheapProfile],
        agentRuntimeConfig: optedInRuntimeConfig,
        issueModelProfile: null,
        contextSnapshot: {},
      });
      expect(modelProfileNoFlag).toMatchObject({ requested: null, applied: null });
    });
  });
});
