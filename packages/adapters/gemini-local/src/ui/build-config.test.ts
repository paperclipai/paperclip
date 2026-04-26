import { describe, expect, it } from "vitest";
import { buildGeminiLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "gemini_local",
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

describe("buildGeminiLocalConfig", () => {
  it("uses DEFAULT_GEMINI_LOCAL_MODEL when model is empty", () => {
    const config = buildGeminiLocalConfig(makeValues({ model: "" }));
    expect(config.model).toBe("auto");
  });

  it("uses the provided model when set", () => {
    const config = buildGeminiLocalConfig(makeValues({ model: "gemini-2.0-flash" }));
    expect(config.model).toBe("gemini-2.0-flash");
  });

  it("includes cwd when provided", () => {
    const config = buildGeminiLocalConfig(makeValues({ cwd: "/my/project" }));
    expect(config.cwd).toBe("/my/project");
  });

  it("omits cwd when empty", () => {
    const config = buildGeminiLocalConfig(makeValues({ cwd: "" }));
    expect(config.cwd).toBeUndefined();
  });

  it("includes instructionsFilePath when provided", () => {
    const config = buildGeminiLocalConfig(makeValues({ instructionsFilePath: "/path/to/CLAUDE.md" }));
    expect(config.instructionsFilePath).toBe("/path/to/CLAUDE.md");
  });

  it("maps bootstrapPrompt to bootstrapPromptTemplate", () => {
    const config = buildGeminiLocalConfig(makeValues({ bootstrapPrompt: "start here" }));
    expect(config.bootstrapPromptTemplate).toBe("start here");
  });

  it("always sets timeoutSec to 0", () => {
    const config = buildGeminiLocalConfig(makeValues());
    expect(config.timeoutSec).toBe(0);
  });

  it("always sets graceSec to 15", () => {
    const config = buildGeminiLocalConfig(makeValues());
    expect(config.graceSec).toBe(15);
  });

  it("sets sandbox=true when dangerouslyBypassSandbox is false", () => {
    const config = buildGeminiLocalConfig(makeValues({ dangerouslyBypassSandbox: false }));
    expect(config.sandbox).toBe(true);
  });

  it("sets sandbox=false when dangerouslyBypassSandbox is true", () => {
    const config = buildGeminiLocalConfig(makeValues({ dangerouslyBypassSandbox: true }));
    expect(config.sandbox).toBe(false);
  });

  it("populates env from envVars text", () => {
    const config = buildGeminiLocalConfig(
      makeValues({ envVars: "API_KEY=secret\nDEBUG=true" }),
    );
    const env = config.env as Record<string, unknown>;
    expect(env).toBeDefined();
    expect(env["API_KEY"]).toEqual({ type: "plain", value: "secret" });
    expect(env["DEBUG"]).toEqual({ type: "plain", value: "true" });
  });

  it("populates env from envBindings with plain values", () => {
    const config = buildGeminiLocalConfig(
      makeValues({ envBindings: { MY_VAR: "value123" } }),
    );
    const env = config.env as Record<string, unknown>;
    expect(env["MY_VAR"]).toEqual({ type: "plain", value: "value123" });
  });

  it("envBindings secret_ref takes priority over envVars for same key", () => {
    const config = buildGeminiLocalConfig(
      makeValues({
        envBindings: { TOKEN: { type: "secret_ref", secretId: "sec-1" } },
        envVars: "TOKEN=plain-value",
      }),
    );
    const env = config.env as Record<string, unknown>;
    expect((env["TOKEN"] as { type: string }).type).toBe("secret_ref");
  });

  it("omits env when no env vars or bindings provided", () => {
    const config = buildGeminiLocalConfig(makeValues({ envVars: "", envBindings: {} }));
    expect(config.env).toBeUndefined();
  });

  it("includes adapterFallbackChain when non-empty", () => {
    const chain = [{ adapterType: "gemini_local" }, { adapterType: "codex_local" }];
    const config = buildGeminiLocalConfig(makeValues({ adapterFallbackChain: chain }));
    expect(config.adapterFallbackChain).toEqual(chain);
  });

  it("omits adapterFallbackChain when empty", () => {
    const config = buildGeminiLocalConfig(makeValues({ adapterFallbackChain: [] }));
    expect(config.adapterFallbackChain).toBeUndefined();
  });

  it("parses extraArgs as comma-separated list", () => {
    const config = buildGeminiLocalConfig(makeValues({ extraArgs: "--flag1, --flag2 , --flag3" }));
    expect(config.extraArgs).toEqual(["--flag1", "--flag2", "--flag3"]);
  });

  it("omits extraArgs when empty", () => {
    const config = buildGeminiLocalConfig(makeValues({ extraArgs: "" }));
    expect(config.extraArgs).toBeUndefined();
  });
});
