import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildOpenCodeLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "opencode_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "opencode-go/minimax-m2.7",
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

describe("buildOpenCodeLocalConfig", () => {
  it("enables a finite adapter timeout by default", () => {
    const config = buildOpenCodeLocalConfig(makeValues());

    expect(config).toMatchObject({
      model: "opencode-go/minimax-m2.7",
      timeoutSec: 15 * 60,
      graceSec: 20,
      dangerouslySkipPermissions: true,
    });
  });
});
