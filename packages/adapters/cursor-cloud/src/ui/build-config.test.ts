import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildCursorCloudConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "cursor_cloud",
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

describe("buildCursorCloudConfig", () => {
  it("persists schema values and top-level prompt fields", () => {
    const config = buildCursorCloudConfig(
      makeValues({
        instructionsFilePath: ".cursor/AGENTS.md",
        promptTemplate: "hello {{agent.name}}",
        bootstrapPrompt: "bootstrap",
        model: "gpt-5.4",
        adapterSchemaValues: {
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          runtimeEnvType: "pool",
          runtimeEnvName: "trusted-workers",
          autoCreatePR: true,
        },
      }),
    );

    expect(config).toMatchObject({
      instructionsFilePath: ".cursor/AGENTS.md",
      promptTemplate: "hello {{agent.name}}",
      bootstrapPromptTemplate: "bootstrap",
      model: "gpt-5.4",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      runtimeEnvType: "pool",
      runtimeEnvName: "trusted-workers",
      autoCreatePR: true,
    });
  });

  it("merges structured env bindings over legacy envVars text", () => {
    const config = buildCursorCloudConfig(
      makeValues({
        envVars: ["CURSOR_API_KEY=legacy-key", "PLAIN=value", "INVALID KEY=nope"].join("\n"),
        envBindings: {
          CURSOR_API_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
          STRUCTURED_ONLY: "from-binding",
        },
      }),
    );

    expect(config.env).toEqual({
      CURSOR_API_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      PLAIN: { type: "plain", value: "value" },
      STRUCTURED_ONLY: { type: "plain", value: "from-binding" },
    });
  });
});
