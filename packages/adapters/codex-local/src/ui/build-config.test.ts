import { describe, expect, it } from "vitest";
import { buildCodexLocalConfig, buildPaperclipRunnerConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "codex_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "gpt-5.4",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: true,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildCodexLocalConfig", () => {
  it.each([undefined, "approve-all", "approve-paperclip", "approve-reads", "deny-all"])(
    "defaults Grok to full auto while preserving an explicit %s permission mode",
    (acpxPermissionMode) => {
      const config = buildPaperclipRunnerConfig(makeValues({
        adapterType: "paperclip_runner",
        model: "",
        adapterSchemaValues: { provider: "acpx", acpxAgent: "grok", acpxPermissionMode },
      }));
      expect(config).toMatchObject({
        provider: "acpx",
        acpxAgent: "grok",
        model: "grok-4.7",
        acpxPermissionMode: acpxPermissionMode ?? "approve-all",
      });
    },
  );

  it.each(["", "grok-4.7-custom"])("retains the Grok harness and its model when normalizing runner fields (%s)", (model) => {
    const values = makeValues({
      model,
      adapterSchemaValues: { provider: "acpx", acpxAgent: "grok", acpxPermissionMode: "approve-paperclip" },
    });
    expect(buildPaperclipRunnerConfig(values)).toMatchObject({
      provider: "acpx",
      acpxAgent: "grok",
      model: model || "grok-4.7",
      acpxPermissionMode: "approve-paperclip",
    });
    expect(values.adapterSchemaValues?.acpxAgent).toBe("grok");
  });

  it("omits engine for the auto default so runtime fallback remains available", () => {
    const config = buildCodexLocalConfig(makeValues({ codexEngine: "auto" }));

    expect(config).not.toHaveProperty("engine");
  });

  it("persists explicit engine pins", () => {
    expect(buildCodexLocalConfig(makeValues({ codexEngine: "cli" }))).toMatchObject({ engine: "cli" });
    expect(buildCodexLocalConfig(makeValues({ codexEngine: "acp" }))).toMatchObject({ engine: "acp" });
  });

  it("persists the fastMode toggle into adapter config", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        search: true,
        fastMode: true,
      }),
    );

    expect(config).toMatchObject({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    });
  });

  it.each([["gpt-6-astra", "ultra"], ["gpt-6.1-sol", "ultra"], ["gpt-6-sol", "ultra"], ["gpt-6-luna", "max"], ["gpt-5.6-sol", "ultra"], ["gpt-5.6-terra", "ultra"], ["gpt-5.6-luna", "max"]])("persists the exact %s model and supported controls", (model, effort) => {
    const config = buildCodexLocalConfig(
      makeValues({
        model,
        thinkingEffort: effort,
        fastMode: true,
      }),
    );

    expect(config).toMatchObject({
      model,
      modelReasoningEffort: effort,
      fastMode: true,
    });
  });

  it("omits model when the operator leaves it blank", () => {
    const config = buildCodexLocalConfig(makeValues({ model: "" }));

    expect(config).not.toHaveProperty("model");
  });
});

describe("buildPaperclipRunnerConfig", () => {
  it.each([undefined, false, true])("preserves Dot attachment consent in create/import forms: %s", value => {
    const config = buildPaperclipRunnerConfig(makeValues({ adapterType: "paperclip_runner", adapterSchemaValues: { provider: "openai_dot", dotAttachmentAccess: value } }));
    expect(config.dotAttachmentAccess).toBe(value === true);
    expect(config.dotWorkspaceAccess).toBe(false);
  });
  it("keeps only settings implemented by the Codex runner profile", () => {
    const config = buildPaperclipRunnerConfig(makeValues({
      codexEngine: "acp",
      codexAcpAgentCommand: "custom-acp",
      codexAcpStateDir: "/tmp/acp",
      search: true,
      fastMode: true,
      dangerouslyBypassSandbox: true,
      instructionsFilePath: "/tmp/AGENTS.md",
      thinkingEffort: "high",
      command: "custom-codex",
      extraArgs: "--unsafe",
    }));

    expect(config).toMatchObject({
      provider: "codex",
      codexPermissionMode: "never",
      lifecycleMode: "per_turn",
      model: "gpt-5.4",
      modelReasoningEffort: "high",
      timeoutSec: 0,
      graceSec: 15,
    });
    for (const unsupportedKey of [
      "engine",
      "agentCommand",
      "stateDir",
      "search",
      "fastMode",
      "dangerouslyBypassApprovalsAndSandbox",
      "command",
      "extraArgs",
    ]) {
      expect(config).not.toHaveProperty(unsupportedKey);
    }
  });

  it("persists bounded Codex permission and warm lifecycle values", () => {
    const config = buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      codexPermissionMode: "never",
      paperclipRunnerLifecycleMode: "warm",
      paperclipRunnerIdleTimeoutMs: 45_000,
    }));

    expect(config).toMatchObject({
      provider: "codex",
      codexPermissionMode: "never",
      lifecycleMode: "warm",
      idleTimeoutMs: 45_000,
    });
  });

  it("rejects an unsupported persisted Codex permission instead of coercing it", () => {
    expect(() => buildPaperclipRunnerConfig(makeValues({
      adapterSchemaValues: {
        provider: "codex",
        codexPermissionMode: "unrestricted",
        lifecycleMode: "forever",
        idleTimeoutMs: -1,
      },
    }))).toThrow("Select Full auto (never ask) before saving");
  });

  it("builds a qualified OpenCode profile from schema-backed values", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "",
      adapterSchemaValues: {
        provider: "opencode",
        opencodePermissionMode: "allow",
      },
    }))).toMatchObject({
      provider: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      opencodePermissionMode: "allow",
      codexPermissionMode: "never",
      acpxPermissionMode: "approve-all",
    });
  });

  it("does not let a stale schema model override the active Codex model", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "gpt-5.6-sol",
      adapterSchemaValues: {
        provider: "codex",
        model: "openrouter/stale-model",
        codexPermissionMode: "never",
      },
    }))).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      codexPermissionMode: "never",
    });
  });

  it.each(["modelReasoningEffort", "reasoningEffort", "effort"].flatMap(effortField => [
    [effortField, "high", true], [effortField, "high", false],
    [effortField, "low", true], [effortField, "low", false],
  ] as const))("uses imported Codex %s with current effort %s without changing other settings (external billing=%s)", (effortField, thinkingEffort, allowUnmeteredProvider) => {
    const importedConfig = {
      provider: "codex",
      model: "gpt-5.6-sol",
      [effortField]: "high",
      allowUnmeteredProvider,
      timeoutSec: 120,
      graceSec: 30,
      env: {
        OPENAI_API_KEY: { type: "secret_ref", secretId: "company-openai", version: "latest" },
      },
    };
    const config = buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: importedConfig.model,
      thinkingEffort,
      envBindings: importedConfig.env,
      adapterSchemaValues: importedConfig,
    }));

    const submittedConfig = JSON.parse(JSON.stringify({ ...importedConfig, ...config }));
    expect(submittedConfig).toMatchObject({
      provider: importedConfig.provider,
      model: importedConfig.model,
      modelReasoningEffort: thinkingEffort,
      allowUnmeteredProvider,
      timeoutSec: importedConfig.timeoutSec,
      graceSec: importedConfig.graceSec,
      env: importedConfig.env,
    });
    expect(submittedConfig).not.toHaveProperty("reasoningEffort");
    expect(submittedConfig).not.toHaveProperty("effort");
    expect(importedConfig[effortField]).toBe("high");
  });

  it.each(["modelReasoningEffort", "reasoningEffort", "effort"])("clears imported Codex %s when the operator selects Auto", (effortField) => {
    const importedConfig = { provider: "codex", [effortField]: "high" };
    const config = buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      thinkingEffort: "",
      adapterSchemaValues: importedConfig,
    }));

    // Imports combine the edited configuration with the saved source before
    // sending JSON. Auto must clear that source value rather than omit an edit.
    const submittedConfig = JSON.parse(JSON.stringify({ ...importedConfig, ...config }));
    expect(submittedConfig).not.toHaveProperty("modelReasoningEffort");
    expect(submittedConfig).not.toHaveProperty("reasoningEffort");
    expect(submittedConfig).not.toHaveProperty("effort");
    expect(importedConfig[effortField]).toBe("high");
  });

  it("preserves non-Codex schema effort fields", () => {
    const schemaValues = {
      provider: "opencode",
      model: "provider/model",
      modelReasoningEffort: "high",
      reasoningEffort: "high",
      effort: "high",
    };
    const config = buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "provider/model",
      thinkingEffort: "low",
      adapterSchemaValues: schemaValues,
    }));
    expect(config).toMatchObject(schemaValues);
  });

  it.each(["claude-opus-5", "my-custom-model"])("preserves the selected ACPX Claude model %s", (model) => {
    expect(buildPaperclipRunnerConfig(makeValues({ model, adapterSchemaValues: { provider: "acpx" } })))
      .toMatchObject({ provider: "acpx", acpxAgent: "claude", model });
  });

  it("normalizes the removed ACPX Codex configuration to native Codex", () => {
    const config = buildPaperclipRunnerConfig(makeValues({ model: "gpt-5.6-sol", adapterSchemaValues: { provider: "acpx", acpxAgent: "codex" } }));
    expect(config).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
    expect(config).not.toHaveProperty("acpxAgent");
  });

  it.each(["pi", "copilot"])("rejects unavailable ACPX %s without selecting another provider", (acpxAgent) => {
    expect(() => buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "explicit-provider-model",
      adapterSchemaValues: {
        provider: "acpx",
        acpxAgent,
      },
    }))).toThrow(/is not enabled for production/);
  });

  it.each(["agent", "plan", "ask"])("preserves Cursor's explicit model and %s mode", (mode) => {
    expect(buildPaperclipRunnerConfig(makeValues({
      model: "explicit-cursor-model",
      adapterSchemaValues: { provider: "acpx", acpxAgent: "cursor", acpxSessionMode: mode },
    }))).toMatchObject({ provider: "acpx", acpxAgent: "cursor", model: "explicit-cursor-model", acpxSessionMode: mode });
  });

  it("defaults Cursor to Agent and requires an explicit model", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      model: "explicit-cursor-model", adapterSchemaValues: { provider: "acpx", acpxAgent: "cursor" },
    }))).toMatchObject({ acpxAgent: "cursor", acpxSessionMode: "agent", model: "explicit-cursor-model" });
    expect(() => buildPaperclipRunnerConfig(makeValues({
      model: "", adapterSchemaValues: { provider: "acpx", acpxAgent: "cursor" },
    }))).toThrow("cursor requires an explicit provider model");
  });

  it("builds a Claude Managed profile reference with explicit retention and spend controls", () => {
    const config = buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "claude-sonnet-5",
      adapterSchemaValues: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
        maxSessionListCostUsd: 0.5,
        anthropicAgentId: "editable-resource-id-must-not-survive",
      },
    }));
    expect(config).toMatchObject({
      provider: "claude_managed",
      managedProfileId: "managed-primary",
      model: "claude-sonnet-5",
      managedAgentsRetentionAcknowledged: true,
      maxSessionListCostUsd: 0.5,
    });
    expect(config).not.toHaveProperty("anthropicAgentId");
  });

  it("builds an AgentCore profile reference with bounded invocation controls", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "",
      adapterSchemaValues: {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-primary",
        agentCoreRetentionAcknowledged: true,
        maxEstimatedSessionCostUsd: 0.75,
        maxIterations: 8,
        maxOutputTokens: 2_048,
        timeoutSeconds: 45,
      },
    }))).toMatchObject({
      provider: "aws_agentcore",
      agentCoreProfileId: "agentcore-primary",
      model: "global.anthropic.claude-sonnet-4-6",
      agentCoreRetentionAcknowledged: true,
      maxEstimatedSessionCostUsd: 0.75,
      maxIterations: 8,
      maxOutputTokens: 2_048,
      timeoutSeconds: 45,
    });
  });

  it.each([
    ["maxIterations", 0],
    ["maxIterations", 9],
    ["maxIterations", "8"],
    ["maxOutputTokens", 4_097],
    ["timeoutSeconds", 301],
  ])("rejects an unsafe AgentCore %s value", (field, value) => {
    expect(() => buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      adapterSchemaValues: {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-primary",
        agentCoreRetentionAcknowledged: true,
        [field]: value,
      },
    }))).toThrow("must be an integer between");
  });

  it("uses the Codex default when no model was selected", () => {
    expect(buildPaperclipRunnerConfig(makeValues({ model: "" }))).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("bounds warm lifecycle values to the shared safe default", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      paperclipRunnerLifecycleMode: "warm",
      paperclipRunnerIdleTimeoutMs: 86_400_001,
    }))).toMatchObject({
      lifecycleMode: "warm",
      idleTimeoutMs: 300_000,
    });
  });

  it("omits an idle timeout for turn-by-turn sessions", () => {
    const config = buildPaperclipRunnerConfig(makeValues({
      paperclipRunnerLifecycleMode: "per_turn",
      paperclipRunnerIdleTimeoutMs: 45_000,
    }));

    expect(config).not.toHaveProperty("idleTimeoutMs");
  });
});
