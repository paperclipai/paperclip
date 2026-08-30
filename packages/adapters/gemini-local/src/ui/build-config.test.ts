import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildGeminiLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "gemini_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "gemini-2.5-pro",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
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

describe("buildGeminiLocalConfig", () => {
  it("omits engine for the auto default so runtime fallback remains available", () => {
    const config = buildGeminiLocalConfig(makeValues({ geminiEngine: "auto" }));

    expect(config).not.toHaveProperty("engine");
  });

  it("persists explicit engine pins", () => {
    expect(buildGeminiLocalConfig(makeValues({ geminiEngine: "cli" }))).toMatchObject({ engine: "cli" });
    expect(buildGeminiLocalConfig(makeValues({ geminiEngine: "acp" }))).toMatchObject({ engine: "acp" });
  });

  it("persists ACP fields when Gemini ACP is selected", () => {
    const config = buildGeminiLocalConfig(makeValues({
      geminiEngine: "acp",
      geminiAcpAgentCommand: "custom-gemini --acp",
      geminiAcpMode: "oneshot",
      geminiAcpNonInteractivePermissions: "fail",
      geminiAcpStateDir: "/tmp/gemini-acp",
      geminiAcpWarmHandleIdleMs: 30,
    }));

    expect(config).toMatchObject({
      engine: "acp",
      agentCommand: "custom-gemini --acp",
      mode: "oneshot",
      nonInteractivePermissions: "fail",
      stateDir: "/tmp/gemini-acp",
      warmHandleIdleMs: 30,
    });
  });
});
