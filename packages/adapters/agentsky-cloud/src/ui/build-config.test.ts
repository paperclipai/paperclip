import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildAgentskyCloudConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "agentsky_cloud",
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

describe("buildAgentskyCloudConfig", () => {
  it("persists schema values and top-level prompt fields", () => {
    const config = buildAgentskyCloudConfig(
      makeValues({
        instructionsFilePath: ".agentsky/AGENTS.md",
        promptTemplate: "hello {{agent.name}}",
        bootstrapPrompt: "bootstrap",
        adapterSchemaValues: {
          harness: "codex",
          model: "gpt-5.6-sol",
          agentSlug: "my-agent",
          apiBaseUrl: "https://staging.agentsky.dev",
        },
      }),
    );

    expect(config).toMatchObject({
      instructionsFilePath: ".agentsky/AGENTS.md",
      promptTemplate: "hello {{agent.name}}",
      bootstrapPromptTemplate: "bootstrap",
      harness: "codex",
      model: "gpt-5.6-sol",
      agentSlug: "my-agent",
      apiBaseUrl: "https://staging.agentsky.dev",
    });
  });

  it("lets the generic model value override the schema model", () => {
    const config = buildAgentskyCloudConfig(
      makeValues({
        model: "claude-fable-5",
        adapterSchemaValues: { harness: "claude_code", model: "claude-opus-5" },
      }),
    );
    expect(config.model).toBe("claude-fable-5");
  });

  it("merges structured env bindings over legacy envVars text", () => {
    const config = buildAgentskyCloudConfig(
      makeValues({
        envVars: ["AGENTSKY_API_TOKEN=legacy-token", "PLAIN=value", "INVALID KEY=nope"].join("\n"),
        envBindings: {
          AGENTSKY_API_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
          STRUCTURED_ONLY: "from-binding",
        },
      }),
    );

    expect(config.env).toEqual({
      AGENTSKY_API_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      PLAIN: { type: "plain", value: "value" },
      STRUCTURED_ONLY: { type: "plain", value: "from-binding" },
    });
  });
});
