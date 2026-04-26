import { describe, expect, it } from "vitest";
import { buildOpenCodeLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "opencode_local",
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

describe("buildOpenCodeLocalConfig", () => {
  it("omits model when not provided", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ model: "" }));
    expect(config.model).toBeUndefined();
  });

  it("uses the provided model when set", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ model: "anthropic/claude-sonnet" }));
    expect(config.model).toBe("anthropic/claude-sonnet");
  });

  it("includes cwd when provided", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ cwd: "/my/project" }));
    expect(config.cwd).toBe("/my/project");
  });

  it("omits cwd when empty", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ cwd: "" }));
    expect(config.cwd).toBeUndefined();
  });

  it("includes instructionsFilePath when provided", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ instructionsFilePath: "/path/to/CLAUDE.md" }));
    expect(config.instructionsFilePath).toBe("/path/to/CLAUDE.md");
  });

  it("maps bootstrapPrompt to bootstrapPromptTemplate", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ bootstrapPrompt: "start here" }));
    expect(config.bootstrapPromptTemplate).toBe("start here");
  });

  it("maps thinkingEffort to variant field", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ thinkingEffort: "high" }));
    expect(config.variant).toBe("high");
  });

  it("omits variant when thinkingEffort is empty", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ thinkingEffort: "" }));
    expect(config.variant).toBeUndefined();
  });

  it("always sets dangerouslySkipPermissions to the provided value (false)", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ dangerouslySkipPermissions: false }));
    expect(config.dangerouslySkipPermissions).toBe(false);
  });

  it("always sets dangerouslySkipPermissions to the provided value (true)", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ dangerouslySkipPermissions: true }));
    expect(config.dangerouslySkipPermissions).toBe(true);
  });

  it("always sets timeoutSec to 0", () => {
    const config = buildOpenCodeLocalConfig(makeValues());
    expect(config.timeoutSec).toBe(0);
  });

  it("always sets graceSec to 20", () => {
    const config = buildOpenCodeLocalConfig(makeValues());
    expect(config.graceSec).toBe(20);
  });

  it("populates env from envVars text", () => {
    const config = buildOpenCodeLocalConfig(
      makeValues({ envVars: "API_KEY=secret\nDEBUG=true" }),
    );
    const env = config.env as Record<string, unknown>;
    expect(env).toBeDefined();
    expect(env["API_KEY"]).toEqual({ type: "plain", value: "secret" });
    expect(env["DEBUG"]).toEqual({ type: "plain", value: "true" });
  });

  it("populates env from envBindings with plain values", () => {
    const config = buildOpenCodeLocalConfig(
      makeValues({ envBindings: { MY_VAR: "value123" } }),
    );
    const env = config.env as Record<string, unknown>;
    expect(env["MY_VAR"]).toEqual({ type: "plain", value: "value123" });
  });

  it("envBindings secret_ref takes priority over envVars for same key", () => {
    const config = buildOpenCodeLocalConfig(
      makeValues({
        envBindings: { TOKEN: { type: "secret_ref", secretId: "sec-1" } },
        envVars: "TOKEN=plain-value",
      }),
    );
    const env = config.env as Record<string, unknown>;
    expect((env["TOKEN"] as { type: string }).type).toBe("secret_ref");
  });

  it("omits env when no env vars or bindings provided", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ envVars: "", envBindings: {} }));
    expect(config.env).toBeUndefined();
  });

  it("includes adapterFallbackChain when non-empty", () => {
    const chain = [{ adapterType: "opencode_local" }, { adapterType: "gemini_local" }];
    const config = buildOpenCodeLocalConfig(makeValues({ adapterFallbackChain: chain }));
    expect(config.adapterFallbackChain).toEqual(chain);
  });

  it("omits adapterFallbackChain when empty", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ adapterFallbackChain: [] }));
    expect(config.adapterFallbackChain).toBeUndefined();
  });

  it("parses extraArgs as comma-separated list", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ extraArgs: "--flag1, --flag2 , --flag3" }));
    expect(config.extraArgs).toEqual(["--flag1", "--flag2", "--flag3"]);
  });

  it("omits extraArgs when empty", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ extraArgs: "" }));
    expect(config.extraArgs).toBeUndefined();
  });

  it("includes command when provided", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ command: "/usr/bin/opencode" }));
    expect(config.command).toBe("/usr/bin/opencode");
  });

  it("omits command when empty", () => {
    const config = buildOpenCodeLocalConfig(makeValues({ command: "" }));
    expect(config.command).toBeUndefined();
  });
});
