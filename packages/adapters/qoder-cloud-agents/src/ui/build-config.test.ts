import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildQoderCloudAgentsConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "qoder_cloud_agents",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
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
    adapterSchemaValues: {},
    ...overrides,
  };
}

describe("buildQoderCloudAgentsConfig", () => {
  it("persists schema values and top-level prompt fields", () => {
    const config = buildQoderCloudAgentsConfig(
      makeValues({
        instructionsFilePath: "agents/AGENTS.md",
        promptTemplate: "hello {{agent.name}}",
        bootstrapPrompt: "bootstrap",
        model: "ultimate",
        adapterSchemaValues: {
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          environmentId: "env_1",
          qoderAgentId: "agent_1",
          timeoutSec: 600,
        },
      }),
    );

    expect(config).toMatchObject({
      instructionsFilePath: "agents/AGENTS.md",
      promptTemplate: "hello {{agent.name}}",
      bootstrapPromptTemplate: "bootstrap",
      model: "ultimate",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      environmentId: "env_1",
      qoderAgentId: "agent_1",
      timeoutSec: 600,
    });
  });

  it("merges structured env bindings over legacy envVars text", () => {
    const config = buildQoderCloudAgentsConfig(
      makeValues({
        envVars: ["QODER_ACCESS_TOKEN=legacy-key", "PLAIN=value", "INVALID KEY=nope"].join("\n"),
        envBindings: {
          QODER_ACCESS_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
          STRUCTURED_ONLY: "from-binding",
        },
      }),
    );

    expect(config.env).toEqual({
      QODER_ACCESS_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      PLAIN: { type: "plain", value: "value" },
      STRUCTURED_ONLY: { type: "plain", value: "from-binding" },
    });
  });
});
