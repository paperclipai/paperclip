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
  it.each(["auto", "cli", "acp"] as const)("preserves explicit timeouts with the %s engine", (claudeEngine) => {
    expect(buildClaudeLocalConfig(makeValues({ claudeEngine, timeoutSec: 1800 })).timeoutSec).toBe(1800);
    expect(buildClaudeLocalConfig(makeValues({ claudeEngine, timeoutSec: 0 })).timeoutSec).toBe(0);
  });

  it("uses schema-backed timeouts and retains the unlimited default", () => {
    expect(buildClaudeLocalConfig(makeValues({ adapterSchemaValues: { timeoutSec: 900 } })).timeoutSec).toBe(900);
    expect(buildClaudeLocalConfig(makeValues({ timeoutSec: 0, adapterSchemaValues: { timeoutSec: 900 } })).timeoutSec).toBe(0);
    expect(buildClaudeLocalConfig(makeValues()).timeoutSec).toBe(0);
  });

  it("omits engine for the auto default so runtime fallback remains available", () => {
    const config = buildClaudeLocalConfig(makeValues({ claudeEngine: "auto" }));

    expect(config).not.toHaveProperty("engine");
  });

  it("persists explicit engine pins", () => {
    expect(buildClaudeLocalConfig(makeValues({ claudeEngine: "cli" }))).toMatchObject({ engine: "cli" });
    expect(buildClaudeLocalConfig(makeValues({ claudeEngine: "acp" }))).toMatchObject({ engine: "acp" });
  });

  it("keeps user-scoped env bindings so the server resolves them at test time", () => {
    const config = buildClaudeLocalConfig(
      makeValues({
        envBindings: {
          GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
        },
      }),
    );

    expect(config.env).toEqual({
      GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
    });
  });

  it("keeps company secret and plain env bindings", () => {
    const config = buildClaudeLocalConfig(
      makeValues({
        envBindings: {
          API_KEY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
          FLAG: { type: "plain", value: "on" },
        },
      }),
    );

    expect(config.env).toEqual({
      API_KEY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
      FLAG: { type: "plain", value: "on" },
    });
  });
});
