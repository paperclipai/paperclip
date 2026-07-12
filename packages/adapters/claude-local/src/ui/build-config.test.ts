import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildClaudeLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "claude_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "claude-opus-4-7",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    claudeEngine: "auto",
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

describe("buildClaudeLocalConfig", () => {
  it("omits engine for the auto default so runtime fallback remains available", () => {
    const config = buildClaudeLocalConfig(makeValues({ claudeEngine: "auto" }));

    expect(config).not.toHaveProperty("engine");
  });

  it("persists explicit engine pins", () => {
    expect(buildClaudeLocalConfig(makeValues({ claudeEngine: "cli" }))).toMatchObject({ engine: "cli" });
    expect(buildClaudeLocalConfig(makeValues({ claudeEngine: "acp" }))).toMatchObject({ engine: "acp" });
  });
});
