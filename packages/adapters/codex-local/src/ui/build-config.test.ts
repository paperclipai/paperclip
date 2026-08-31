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

  it("builds a bounded OpenCode runner profile from schema values", () => {
    const config = buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "",
      codexEngine: "acp",
      dangerouslyBypassSandbox: true,
      adapterSchemaValues: {
        provider: "opencode",
        opencodePermissionMode: "ask",
        lifecycleMode: "warm",
        idleTimeoutMs: 45_000,
      },
    }));

    expect(config).toMatchObject({
      provider: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      opencodePermissionMode: "ask",
      lifecycleMode: "warm",
      idleTimeoutMs: 45_000,
    });
    expect(config).not.toHaveProperty("engine");
    expect(config).not.toHaveProperty("dangerouslyBypassApprovalsAndSandbox");
  });

  it("falls back to safe OpenCode defaults for invalid schema values", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterSchemaValues: {
        provider: "opencode",
        opencodePermissionMode: "unrestricted",
        lifecycleMode: "forever",
        idleTimeoutMs: -1,
      },
    }))).toMatchObject({
      provider: "opencode",
      opencodePermissionMode: "allow",
      lifecycleMode: "per_turn",
    });
  });
});
