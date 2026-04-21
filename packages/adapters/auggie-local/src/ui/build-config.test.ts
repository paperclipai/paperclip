import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildAuggieLocalConfig } from "./build-config.js";
import { DEFAULT_AUGGIE_LOCAL_MODEL } from "../index.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "auggie_local",
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
    ...overrides,
  };
}

describe("buildAuggieLocalConfig", () => {
  it("falls back to the default model when none is supplied", () => {
    const config = buildAuggieLocalConfig(makeValues());
    expect(config).toMatchObject({
      model: DEFAULT_AUGGIE_LOCAL_MODEL,
      timeoutSec: 0,
      graceSec: 20,
    });
    expect(config).not.toHaveProperty("env");
    expect(config).not.toHaveProperty("cwd");
  });

  it("persists cwd, instructions, prompt template and bootstrap prompt", () => {
    const config = buildAuggieLocalConfig(
      makeValues({
        cwd: "/tmp/work",
        instructionsFilePath: "/tmp/AGENTS.md",
        promptTemplate: "{{issue.title}}",
        bootstrapPrompt: "Start by reading AGENTS.md",
      }),
    );
    expect(config).toMatchObject({
      cwd: "/tmp/work",
      instructionsFilePath: "/tmp/AGENTS.md",
      promptTemplate: "{{issue.title}}",
      bootstrapPromptTemplate: "Start by reading AGENTS.md",
    });
  });

  it("parses newline-separated env vars into plain bindings", () => {
    const config = buildAuggieLocalConfig(
      makeValues({ envVars: "FOO=bar\n# comment\nBAZ=qux\ninvalid line\n" }),
    );
    expect(config.env).toEqual({
      FOO: { type: "plain", value: "bar" },
      BAZ: { type: "plain", value: "qux" },
    });
  });

  it("preserves structured envBindings and only augments with legacy envVars that are not already present", () => {
    const config = buildAuggieLocalConfig(
      makeValues({
        envBindings: {
          AUGMENT_SESSION_AUTH: { type: "secret_ref", secretId: "sec_123", version: "latest" },
          FOO: { type: "plain", value: "structured" },
        },
        envVars: "FOO=legacy\nBAR=added",
      }),
    );
    expect(config.env).toEqual({
      AUGMENT_SESSION_AUTH: {
        type: "secret_ref",
        secretId: "sec_123",
        version: "latest",
      },
      FOO: { type: "plain", value: "structured" },
      BAR: { type: "plain", value: "added" },
    });
  });

  it("parses comma-separated extraArgs into a list", () => {
    const config = buildAuggieLocalConfig(
      makeValues({ extraArgs: "--max-turns,5, --verbose ,  " }),
    );
    expect(config.extraArgs).toEqual(["--max-turns", "5", "--verbose"]);
  });

  it("persists a custom command when provided", () => {
    const config = buildAuggieLocalConfig(makeValues({ command: "/usr/local/bin/auggie" }));
    expect(config.command).toBe("/usr/local/bin/auggie");
  });
});
