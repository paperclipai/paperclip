import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildKimiLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "kimi_local",
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

describe("buildKimiLocalConfig", () => {
  it("defaults the model to kimi-code/kimi-for-coding when unset", () => {
    const config = buildKimiLocalConfig(makeValues());

    expect(config.model).toBe("kimi-code/kimi-for-coding");
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(15);
  });

  it("persists an explicit model and command", () => {
    const config = buildKimiLocalConfig(makeValues({
      model: "kimi-code/k3",
      command: "/usr/local/bin/kimi",
    }));

    expect(config.model).toBe("kimi-code/k3");
    expect(config.command).toBe("/usr/local/bin/kimi");
  });

  it("persists cwd, instructionsFilePath, and extra args", () => {
    const config = buildKimiLocalConfig(makeValues({
      cwd: "/tmp/project",
      instructionsFilePath: "/tmp/project/AGENTS.md",
      extraArgs: "--add-dir /tmp/other, --plan",
    }));

    expect(config.cwd).toBe("/tmp/project");
    expect(config.instructionsFilePath).toBe("/tmp/project/AGENTS.md");
    expect(config.extraArgs).toEqual(["--add-dir /tmp/other", "--plan"]);
  });

  it("merges legacy env vars with secret bindings", () => {
    const config = buildKimiLocalConfig(makeValues({
      envVars: "KIMI_MODEL_NAME=kimi-code/k3\n# comment\nINVALID LINE",
      envBindings: {
        KIMI_MODEL_API_KEY: { type: "secret_ref", secretId: "secret-1" },
      },
    }));

    expect(config.env).toEqual({
      KIMI_MODEL_NAME: { type: "plain", value: "kimi-code/k3" },
      KIMI_MODEL_API_KEY: { type: "secret_ref", secretId: "secret-1" },
    });
  });
});
