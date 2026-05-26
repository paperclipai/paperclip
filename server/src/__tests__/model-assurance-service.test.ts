import { describe, expect, it } from "vitest";

import { evaluateModelAssurance, modelAssuranceService } from "../services/model-assurance/index.js";

function createSelectSequenceDb(rowSets: unknown[][]) {
  let selectCalls = 0;

  return {
    get selectCalls() {
      return selectCalls;
    },
    select: () => {
      const rows = rowSets[selectCalls] ?? [];
      selectCalls += 1;

      return {
        from: () => ({
          where: () => ({
            limit: async () => rows,
            orderBy: () => ({
              limit: async () => rows,
            }),
          }),
        }),
      };
    },
  };
}

describe("evaluateModelAssurance", () => {
  it("approves codex primary model for engineering implementation", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "codex_local",
        agentRole: "engineering",
        selectedModel: "gpt-5.3-codex",
        knownModels: [{ id: "gpt-5.3-codex", label: "gpt-5.3-codex" }],
        detectedModel: null,
        modelProfiles: [
          {
            key: "cheap",
            label: "Cheap",
            adapterConfig: { model: "gpt-5.3-codex-spark" },
            source: "adapter_default",
          },
        ],
        helloRunSucceeded: true,
      }),
    ).toMatchObject({
      policyStatus: "approved_primary",
      roleFit: "strong",
      modelAvailable: true,
      modelRunnable: true,
      reasonCodes: [],
    });
  });

  it("allows codex manual undiscovered model until hello-run proves it", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "codex_local",
        agentRole: "engineering",
        selectedModel: "manual-future-model",
        knownModels: [],
        detectedModel: null,
        modelProfiles: [],
        helloRunSucceeded: false,
      }),
    ).toMatchObject({
      policyStatus: "manual_allowed",
      modelAvailable: false,
      modelRunnable: false,
      reasonCodes: ["model_not_listed", "manual_model_unverified", "cheap_profile_missing"],
    });
  });

  it("blocks weak role fit for cheap model on governed decision work", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "agy_local",
        agentRole: "governance",
        selectedModel: "gemini-3.5-flash",
        knownModels: [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }],
        detectedModel: null,
        modelProfiles: [
          {
            key: "cheap",
            label: "Cheap",
            adapterConfig: { model: "gemini-3.5-flash" },
            source: "adapter_default",
          },
        ],
        helloRunSucceeded: true,
      }),
    ).toMatchObject({
      policyStatus: "blocked",
      roleFit: "blocked",
      reasonCodes: ["role_fit_weak"],
    });
  });

  it("blocks agy_local when the resolved model is not gemini-3.5-flash", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "agy_local",
        agentRole: "research",
        selectedModel: "gemini-3.1-pro",
        knownModels: [{ id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" }],
        detectedModel: null,
        modelProfiles: [
          {
            key: "cheap",
            label: "Cheap",
            adapterConfig: { model: "gemini-3.5-flash" },
            source: "adapter_default",
          },
        ],
        helloRunSucceeded: true,
      }),
    ).toMatchObject({
      policyStatus: "blocked",
      roleFit: "blocked",
      roleFitReason: "AGY MVP certification only allows gemini-3.5-flash.",
      reasonCodes: ["role_fit_weak", "cost_policy_blocked"],
    });
  });

  it("approves agy_local gemini-3.5-flash as strong for research when not cheap", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "agy_local",
        agentRole: "research",
        selectedModel: "gemini-3.5-flash",
        knownModels: [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }],
        detectedModel: null,
        modelProfiles: [
          {
            key: "cheap",
            label: "Cheap",
            adapterConfig: { model: "gemini-3.5-flash-lite" },
            source: "adapter_default",
          },
        ],
        helloRunSucceeded: true,
      }),
    ).toMatchObject({
      policyStatus: "approved_primary",
      roleFit: "strong",
      reasonCodes: [],
    });
  });

  it("flags malformed cheap profiles as missing", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "codex_local",
        agentRole: "engineering",
        selectedModel: "gpt-5.3-codex",
        knownModels: [{ id: "gpt-5.3-codex", label: "gpt-5.3-codex" }],
        detectedModel: null,
        modelProfiles: [
          {
            key: "cheap",
            label: "Cheap",
            adapterConfig: {},
            source: "adapter_default",
          },
        ],
        helloRunSucceeded: true,
      }).reasonCodes,
    ).toContain("cheap_profile_missing");
  });

  it("blocks known configured models that fail a hello-run", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "codex_local",
        agentRole: "engineering",
        selectedModel: "gpt-5.3-codex",
        knownModels: [{ id: "gpt-5.3-codex", label: "gpt-5.3-codex" }],
        detectedModel: null,
        modelProfiles: [
          {
            key: "cheap",
            label: "Cheap",
            adapterConfig: { model: "gpt-5.3-codex-spark" },
            source: "adapter_default",
          },
        ],
        helloRunSucceeded: false,
      }),
    ).toMatchObject({
      policyStatus: "blocked",
      modelRunnable: false,
      reasonCodes: ["model_hello_failed"],
    });
  });

  it("warns rather than blocks when a model hello run has not been executed", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "codex_local",
        agentRole: "engineering",
        selectedModel: "gpt-5.3-codex",
        knownModels: [{ id: "gpt-5.3-codex", label: "gpt-5.3-codex" }],
        detectedModel: null,
        modelProfiles: [
          {
            key: "cheap",
            label: "Cheap",
            adapterConfig: { model: "gpt-5.3-codex-spark" },
            source: "adapter_default",
          },
        ],
        helloRunSucceeded: null,
      }),
    ).toMatchObject({
      policyStatus: "warning",
      modelRunnable: false,
      reasonCodes: [],
    });
  });

  it("does not treat unknown detected codex models as manually approved", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "codex_local",
        agentRole: "engineering",
        selectedModel: null,
        knownModels: [],
        detectedModel: "detected-future-model",
        modelProfiles: [
          {
            key: "cheap",
            label: "Cheap",
            adapterConfig: { model: "gpt-5.3-codex-spark" },
            source: "adapter_default",
          },
        ],
        helloRunSucceeded: true,
      }),
    ).toMatchObject({
      policyStatus: "warning",
      modelAvailable: false,
      reasonCodes: ["model_not_listed"],
    });
  });

  it("blocks unresolved models", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "claude_local",
        agentRole: "governance",
        selectedModel: null,
        knownModels: [],
        detectedModel: null,
        modelProfiles: [],
        helloRunSucceeded: false,
      }),
    ).toMatchObject({
      policyStatus: "blocked",
      roleFit: "unknown",
      reasonCodes: ["model_unresolved", "model_hello_failed", "cheap_profile_missing"],
    });
  });

  it("degrades invalid latest-row enum values before returning API shape", async () => {
    const db = createSelectSequenceDb([
      [{ id: "agent-1" }],
      [
        {
          model: "model-x",
          resolvedModel: "model-x",
          modelSource: "bad_source",
          modelProfile: "primary",
          modelAvailable: true,
          modelRunnable: true,
          modelPolicyStatus: "not_a_status",
          roleFit: "not_a_fit",
          roleFitReason: "bad row",
          modelReasonCodesJson: ["model_not_listed", "bad_reason"],
          modelCapabilitiesJson: { safe: true },
        },
      ],
    ]);

    await expect(modelAssuranceService(db as never).getLatestForAgent("company-1", "agent-1")).resolves.toMatchObject({
      modelSource: "unknown",
      policyStatus: "unknown",
      roleFit: "unknown",
      reasonCodes: ["model_not_listed"],
    });
  });

  it("rejects latest model assurance reads when the agent is not in the requested company", async () => {
    const db = createSelectSequenceDb([[]]);

    await expect(
      modelAssuranceService(db as never).getLatestForAgent("company-1", "cross-company-agent"),
    ).rejects.toMatchObject({
      status: 404,
      message: "Agent not found",
    });
    expect(db.selectCalls).toBe(1);
  });

  it("returns null for owned agents that do not have non-expired model evidence", async () => {
    const db = createSelectSequenceDb([[{ id: "agent-1" }], []]);

    await expect(modelAssuranceService(db as never).getLatestForAgent("company-1", "agent-1")).resolves.toBeNull();
    expect(db.selectCalls).toBe(2);
  });

  it("validates agent existence before model assurance probe reads latest evidence", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    await expect(modelAssuranceService(db as never).probeAgent("company-1", "missing-agent")).rejects.toMatchObject({
      status: 404,
      message: "Agent not found",
    });
  });
});
