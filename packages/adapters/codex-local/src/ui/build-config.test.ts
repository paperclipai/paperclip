import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildCodexLocalConfig } from "./build-config.js";

function createValues(): CreateConfigValues {
  return {
    adapterType: "codex_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "none",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 3600,
  };
}

describe("buildCodexLocalConfig", () => {
  it("defaults bypass mode to explicit opt-in", () => {
    const values = { ...createValues(), dangerouslyBypassSandbox: undefined } as unknown as CreateConfigValues;
    const config = buildCodexLocalConfig(values);
    expect(config.dangerouslyBypassApprovalsAndSandbox).toBe(false);
  });
});
