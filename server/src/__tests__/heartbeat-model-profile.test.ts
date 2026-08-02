import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  assertRequestedModelProfileApplied,
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveAdapterRunOutcome,
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

  it("refuses the primary config when the adapter does not support the requested profile", () => {
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
    expect(() => assertRequestedModelProfileApplied(modelProfile)).toThrow(
      /refusing to fall back to the primary adapter configuration/,
    );
  });

  it("fails closed before dispatch when status-only recovery requests a disabled cheap profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: false,
            adapterConfig: { model: "disabled-cheap" },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap", recoveryIntent: "status_only" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: null,
      fallbackReason: "agent_runtime_profile_disabled",
    });
    expect(() => assertRequestedModelProfileApplied(modelProfile)).toThrowError(
      expect.objectContaining({
        name: "ConfigurationIncompleteFailure",
        code: "configuration_incomplete",
        resultJson: expect.objectContaining({
          configurationIncomplete: expect.objectContaining({
            reason: "requested_model_profile_unavailable",
            requestedModelProfile: "cheap",
            fallbackReason: "agent_runtime_profile_disabled",
          }),
        }),
      }),
    );
  });

  it("dispatches a status-only recovery hint on the base config when the adapter has no profiles", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {},
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap", recoveryIntent: "status_only" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      bestEffortRecoveryHint: true,
    });
    // A best-effort recovery hint degrades to the base adapter config instead of
    // failing the run closed; the missing-comment retry must still dispatch.
    expect(() => assertRequestedModelProfileApplied(modelProfile)).not.toThrow();
  });

  it("keeps an explicit wake-context request fail-closed even when the adapter has no profiles", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {},
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      bestEffortRecoveryHint: false,
    });
    expect(() => assertRequestedModelProfileApplied(modelProfile)).toThrow(
      /refusing to fall back to the primary adapter configuration/,
    );
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
});

describe("heartbeat adapter outcome", () => {
  it.each(["error", "failed", "failure", "errored", " ERROR "])(
    "maps an exit-zero adapter result with status=%j to failed",
    (status) => {
      expect(resolveAdapterRunOutcome({
        adapterResult: {
          exitCode: 0,
          timedOut: false,
          errorMessage: null,
          resultJson: { status },
        },
      })).toBe("failed");
    },
  );

  it("keeps timeout priority over a semantic adapter failure", () => {
    expect(resolveAdapterRunOutcome({
      adapterResult: {
        exitCode: 0,
        timedOut: true,
        errorMessage: null,
        resultJson: { status: "error" },
      },
    })).toBe("timed_out");
  });

  it("preserves an already-terminal concurrent cancellation", () => {
    expect(resolveAdapterRunOutcome({
      currentTerminalStatus: "cancelled",
      adapterResult: {
        exitCode: 0,
        timedOut: false,
        errorMessage: null,
        resultJson: { status: "completed" },
      },
    })).toBe("cancelled");
  });

  it("does not interpret nested status fields as the adapter outcome", () => {
    expect(resolveAdapterRunOutcome({
      adapterResult: {
        exitCode: 0,
        timedOut: false,
        errorMessage: null,
        resultJson: { status: "completed", detail: { status: "error" } },
      },
    })).toBe("succeeded");
  });
});
