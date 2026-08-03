import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildJcodeLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "jcode_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "anthropic/claude-sonnet-4-5",
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
    ...overrides,
  };
}

describe("buildJcodeLocalConfig", () => {
  it("builds core runtime config", () => {
    expect(
      buildJcodeLocalConfig(
        makeValues({
          cwd: "/tmp/work",
          instructionsFilePath: "/tmp/work/AGENTS.md",
          command: "jcode-dev",
          extraArgs: "--flag",
        }),
      ),
    ).toMatchObject({
      cwd: "/tmp/work",
      instructionsFilePath: "/tmp/work/AGENTS.md",
      model: "anthropic/claude-sonnet-4-5",
      command: "jcode-dev",
      extraArgs: "--flag",
      timeoutSec: 0,
      graceSec: 20,
    });
  });

  it("normalizes env bindings and legacy env vars", () => {
    const config = buildJcodeLocalConfig(
      makeValues({
        envBindings: {
          JCODE_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
          PLAIN_VALUE: { type: "plain", value: "from-binding" },
        },
        envVars: "PLAIN_VALUE=from-legacy\nEXTRA=value\nBAD-NAME=ignored",
      }),
    );

    expect(config.env).toEqual({
      JCODE_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      PLAIN_VALUE: { type: "plain", value: "from-binding" },
      EXTRA: { type: "plain", value: "value" },
    });
  });

  it("omits model when the operator leaves it blank", () => {
    const config = buildJcodeLocalConfig(makeValues({ model: "" }));

    expect(config).not.toHaveProperty("model");
  });
});
