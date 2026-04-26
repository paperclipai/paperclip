import { describe, expect, it } from "vitest";
import { buildPiLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "pi_local",
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

describe("buildPiLocalConfig", () => {
  it("omits model when not provided", () => {
    const config = buildPiLocalConfig(makeValues({ model: "" }));
    expect(config.model).toBeUndefined();
  });

  it("uses the provided model when set", () => {
    const config = buildPiLocalConfig(makeValues({ model: "pi-model-v2" }));
    expect(config.model).toBe("pi-model-v2");
  });

  it("includes cwd when provided", () => {
    const config = buildPiLocalConfig(makeValues({ cwd: "/my/project" }));
    expect(config.cwd).toBe("/my/project");
  });

  it("omits cwd when empty", () => {
    const config = buildPiLocalConfig(makeValues({ cwd: "" }));
    expect(config.cwd).toBeUndefined();
  });

  it("includes instructionsFilePath when provided", () => {
    const config = buildPiLocalConfig(makeValues({ instructionsFilePath: "/path/to/CLAUDE.md" }));
    expect(config.instructionsFilePath).toBe("/path/to/CLAUDE.md");
  });

  it("omits instructionsFilePath when empty", () => {
    const config = buildPiLocalConfig(makeValues({ instructionsFilePath: "" }));
    expect(config.instructionsFilePath).toBeUndefined();
  });

  it("maps bootstrapPrompt to bootstrapPromptTemplate", () => {
    const config = buildPiLocalConfig(makeValues({ bootstrapPrompt: "start here" }));
    expect(config.bootstrapPromptTemplate).toBe("start here");
  });

  it("maps thinkingEffort to thinking field", () => {
    const config = buildPiLocalConfig(makeValues({ thinkingEffort: "high" }));
    expect(config.thinking).toBe("high");
  });

  it("omits thinking when thinkingEffort is empty", () => {
    const config = buildPiLocalConfig(makeValues({ thinkingEffort: "" }));
    expect(config.thinking).toBeUndefined();
  });

  it("always sets timeoutSec to 0", () => {
    const config = buildPiLocalConfig(makeValues());
    expect(config.timeoutSec).toBe(0);
  });

  it("always sets graceSec to 20", () => {
    const config = buildPiLocalConfig(makeValues());
    expect(config.graceSec).toBe(20);
  });

  it("populates env from envVars text", () => {
    const config = buildPiLocalConfig(
      makeValues({ envVars: "API_KEY=secret\nDEBUG=true" }),
    );
    const env = config.env as Record<string, unknown>;
    expect(env).toBeDefined();
    expect(env["API_KEY"]).toEqual({ type: "plain", value: "secret" });
    expect(env["DEBUG"]).toEqual({ type: "plain", value: "true" });
  });

  it("populates env from envBindings with plain values", () => {
    const config = buildPiLocalConfig(
      makeValues({ envBindings: { MY_VAR: "value123" } }),
    );
    const env = config.env as Record<string, unknown>;
    expect(env["MY_VAR"]).toEqual({ type: "plain", value: "value123" });
  });

  it("envBindings secret_ref takes priority over envVars for same key", () => {
    const config = buildPiLocalConfig(
      makeValues({
        envBindings: { TOKEN: { type: "secret_ref", secretId: "sec-1" } },
        envVars: "TOKEN=plain-value",
      }),
    );
    const env = config.env as Record<string, unknown>;
    expect((env["TOKEN"] as { type: string }).type).toBe("secret_ref");
  });

  it("omits env when no env vars or bindings provided", () => {
    const config = buildPiLocalConfig(makeValues({ envVars: "", envBindings: {} }));
    expect(config.env).toBeUndefined();
  });

  it("includes adapterFallbackChain when non-empty", () => {
    const chain = [{ adapterType: "pi_local" }, { adapterType: "gemini_local" }];
    const config = buildPiLocalConfig(makeValues({ adapterFallbackChain: chain }));
    expect(config.adapterFallbackChain).toEqual(chain);
  });

  it("omits adapterFallbackChain when empty", () => {
    const config = buildPiLocalConfig(makeValues({ adapterFallbackChain: [] }));
    expect(config.adapterFallbackChain).toBeUndefined();
  });

  it("passes extraArgs through as-is (not comma-split)", () => {
    const config = buildPiLocalConfig(makeValues({ extraArgs: "--flag1 --flag2" }));
    expect(config.extraArgs).toBe("--flag1 --flag2");
  });

  it("omits extraArgs when empty", () => {
    const config = buildPiLocalConfig(makeValues({ extraArgs: "" }));
    expect(config.extraArgs).toBeUndefined();
  });

  it("includes args when provided", () => {
    const config = buildPiLocalConfig(makeValues({ args: "--some-arg" }));
    expect(config.args).toBe("--some-arg");
  });

  it("omits args when empty", () => {
    const config = buildPiLocalConfig(makeValues({ args: "" }));
    expect(config.args).toBeUndefined();
  });

  it("includes command when provided", () => {
    const config = buildPiLocalConfig(makeValues({ command: "/usr/bin/pi" }));
    expect(config.command).toBe("/usr/bin/pi");
  });

  it("omits command when empty", () => {
    const config = buildPiLocalConfig(makeValues({ command: "" }));
    expect(config.command).toBeUndefined();
  });
});
