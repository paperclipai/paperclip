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

  it("omits model when the operator leaves it blank", () => {
    const config = buildCodexLocalConfig(makeValues({ model: "" }));

    expect(config).not.toHaveProperty("model");
  });
});

describe("buildPaperclipRunnerConfig", () => {
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
      codexPermissionMode: "untrusted",
      lifecycleMode: "per_turn",
      model: "gpt-5.4",
      timeoutSec: 0,
      graceSec: 15,
    });
    for (const unsupportedKey of [
      "engine",
      "agentCommand",
      "stateDir",
      "instructionsFilePath",
      "modelReasoningEffort",
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
      codexPermissionMode: "untrusted",
      paperclipRunnerLifecycleMode: "warm",
      paperclipRunnerIdleTimeoutMs: 45_000,
    }));

    expect(config).toMatchObject({
      provider: "codex",
      codexPermissionMode: "untrusted",
      lifecycleMode: "warm",
      idleTimeoutMs: 45_000,
    });
  });

  it("fails closed to the Codex profile and safe defaults for stale schema values", () => {
    const config = buildPaperclipRunnerConfig(makeValues({
      adapterSchemaValues: {
        provider: "unknown",
        codexPermissionMode: "unrestricted",
        lifecycleMode: "forever",
        idleTimeoutMs: -1,
      },
    }));
    expect(config).toMatchObject({
      provider: "codex",
      codexPermissionMode: "untrusted",
      lifecycleMode: "per_turn",
    });
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
      codexPermissionMode: "untrusted",
      acpxPermissionMode: "approve-reads",
    });
  });

  it("does not let a stale schema model override the active Codex model", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "gpt-5.6-sol",
      adapterSchemaValues: {
        provider: "codex",
        model: "openrouter/stale-model",
        codexPermissionMode: "on-request",
      },
    }))).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      codexPermissionMode: "on-request",
    });
  });

  it.each([
    ["claude", "claude-sonnet-5"],
    ["codex", "gpt-5.6-sol"],
  ] as const)("builds the qualified ACPX %s profile", (acpxAgent, model) => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "stale-model-from-another-provider",
      adapterSchemaValues: {
        provider: "acpx",
        acpxAgent,
        acpxPermissionMode: "approve-all",
      },
    }))).toMatchObject({
      provider: "acpx",
      acpxAgent,
      model,
      acpxPermissionMode: "approve-all",
    });
  });

  it("does not materialize the unavailable ACPX Pi profile", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "",
      adapterSchemaValues: {
        provider: "acpx",
        acpxAgent: "pi",
      },
    }))).toMatchObject({
      provider: "acpx",
      acpxAgent: "claude",
      model: "claude-sonnet-5",
    });
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
