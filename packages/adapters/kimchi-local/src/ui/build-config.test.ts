import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildKimchiLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "kimchi_local",
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

describe("buildKimchiLocalConfig", () => {
  it("does not pin a default model (kimchi picks its own default in-session)", () => {
    const config = buildKimchiLocalConfig(makeValues());
    expect("model" in config).toBe(false);
  });

  it("persists an explicit model and command", () => {
    const config = buildKimchiLocalConfig(makeValues({
      model: "glm-5.3",
      command: "/usr/local/bin/kimchi",
    }));

    expect(config.model).toBe("glm-5.3");
    expect(config.command).toBe("/usr/local/bin/kimchi");
  });

  it("persists cwd, instructionsFilePath, and extra args", () => {
    const config = buildKimchiLocalConfig(makeValues({
      cwd: "/tmp/project",
      instructionsFilePath: "/tmp/project/AGENTS.md",
      extraArgs: "--verbose, --strict",
    }));

    expect(config.cwd).toBe("/tmp/project");
    expect(config.instructionsFilePath).toBe("/tmp/project/AGENTS.md");
    expect(config.extraArgs).toEqual(["--verbose", "--strict"]);
  });

  it("merges legacy env vars with secret bindings", () => {
    const config = buildKimchiLocalConfig(makeValues({
      envVars: "KIMCHI_TELEMETRY_ENABLED=0\n# comment\nINVALID LINE",
      envBindings: {
        KIMCHI_API_KEY: { type: "secret_ref", secretId: "secret-1" },
      },
    }));

    expect(config.env).toEqual({
      KIMCHI_TELEMETRY_ENABLED: { type: "plain", value: "0" },
      KIMCHI_API_KEY: { type: "secret_ref", secretId: "secret-1" },
    });
  });
});
