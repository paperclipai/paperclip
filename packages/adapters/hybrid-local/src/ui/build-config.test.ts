import { describe, expect, it } from "vitest";
import { buildHybridLocalConfig } from "./build-config.js";

describe("buildHybridLocalConfig", () => {
  it("includes maxTotalTokens in the adapter config", () => {
    const config = buildHybridLocalConfig({
      adapterType: "hybrid_local",
      cwd: "",
      instructionsFilePath: "",
      promptTemplate: "",
      model: "qwen3-coder:latest",
      codingModel: "claude-sonnet-4-6",
      localToolMode: "read_only",
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: true,
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
      workspaceStrategyType: "project_primary",
      workspaceBaseRef: "",
      workspaceBranchTemplate: "",
      worktreeParentDir: "",
      runtimeServicesJson: "",
      maxTurnsPerRun: 300,
      maxTotalTokens: 300000,
      heartbeatEnabled: false,
      intervalSec: 300,
    });

    expect(config.maxTotalTokens).toBe(300000);
    expect(config.codingModel).toBe("claude-sonnet-4-6");
    expect(config.localToolMode).toBe("read_only");
  });
});
