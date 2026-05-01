import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildCopilotLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "copilot_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
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

describe("buildCopilotLocalConfig", () => {
  it("builds config with merged env vars and defaults", () => {
    const config = buildCopilotLocalConfig(
      makeValues({
        cwd: "/workspace/repo",
        instructionsFilePath: ".paperclip/AGENTS.md",
        promptTemplate: "Do work",
        bootstrapPrompt: "Bootstrap",
        command: "copilot",
        extraArgs: "--trace, --jsonl",
        envVars: "OPENAI_API_KEY=abc\nINVALID-KEY=ignored",
      }),
    );

    expect(config).toMatchObject({
      cwd: "/workspace/repo",
      instructionsFilePath: ".paperclip/AGENTS.md",
      promptTemplate: "Do work",
      bootstrapPromptTemplate: "Bootstrap",
      model: "claude-sonnet-4.6",
      command: "copilot",
      extraArgs: ["--trace", "--jsonl"],
      timeoutSec: 0,
      graceSec: 15,
      env: {
        OPENAI_API_KEY: { type: "plain", value: "abc" },
      },
    });
  });

  it("includes copilot-specific fields from the create form", () => {
    const config = buildCopilotLocalConfig(
      makeValues({
        model: "gpt-4.1",
        thinkingEffort: "xhigh",
        dangerouslyBypassSandbox: true,
        workspaceStrategyType: "git_worktree",
        workspaceBaseRef: "main",
        workspaceBranchTemplate: "paperclip/{{issue.number}}",
        worktreeParentDir: "/worktrees",
        runtimeServicesJson: JSON.stringify({ services: [{ name: "db", command: "docker compose up db" }] }),
      }),
    );

    expect(config).toMatchObject({
      model: "gpt-4.1",
      effort: "xhigh",
      dangerouslyBypassApprovalsAndSandbox: true,
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: "main",
        branchTemplate: "paperclip/{{issue.number}}",
        worktreeParentDir: "/worktrees",
      },
      workspaceRuntime: {
        services: [{ name: "db", command: "docker compose up db" }],
      },
    });
  });
});
