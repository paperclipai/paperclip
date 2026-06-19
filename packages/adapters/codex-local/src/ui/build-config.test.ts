import { describe, expect, it } from "vitest";
import { buildCodexLocalConfig } from "./build-config.js";
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
    maxContextTokens: 200000,
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
      maxContextTokens: 200000,
      dangerouslyBypassApprovalsAndSandbox: true,
    });
  });

  it("persists maxContextTokens into adapter config", () => {
    const config = buildCodexLocalConfig(makeValues({ maxContextTokens: 150000 }));

    expect(config).toMatchObject({
      maxContextTokens: 150000,
    });
  });

  it("omits model when the operator leaves it blank", () => {
    const config = buildCodexLocalConfig(makeValues({ model: "" }));

    expect(config).not.toHaveProperty("model");
  });
});
