import { describe, expect, it } from "vitest";
import { buildCursorLocalConfig } from "./build-config.js";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "../index.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function base(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "cursor_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    bootstrapPrompt: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    dangerouslySkipPermissions: false,
    envVars: "",
    envBindings: {},
    url: "",
    args: "",
    extraArgs: "",
    maxTurnsPerRun: 10,
    heartbeatEnabled: false,
    intervalSec: 60,
    adapterFallbackChain: [],
    fallbackToCodexOnRateLimit: false,
    command: "",
    ...overrides,
  };
}

// ============================================================================
// Always-set fields
// ============================================================================

describe("buildCursorLocalConfig — always-set fields", () => {
  it("always sets timeoutSec to 0", () => {
    const config = buildCursorLocalConfig(base());
    expect(config.timeoutSec).toBe(0);
  });

  it("always sets graceSec to 15", () => {
    const config = buildCursorLocalConfig(base());
    expect(config.graceSec).toBe(15);
  });

  it("uses DEFAULT_CURSOR_LOCAL_MODEL when model is empty", () => {
    const config = buildCursorLocalConfig(base({ model: "" }));
    expect(config.model).toBe(DEFAULT_CURSOR_LOCAL_MODEL);
  });

  it("uses the provided model when set", () => {
    const config = buildCursorLocalConfig(base({ model: "gpt-5.3-codex" }));
    expect(config.model).toBe("gpt-5.3-codex");
  });
});

// ============================================================================
// mode normalization (thinkingEffort → mode)
// ============================================================================

describe("buildCursorLocalConfig — mode normalization", () => {
  it("sets mode to 'plan' for thinkingEffort=plan", () => {
    const config = buildCursorLocalConfig(base({ thinkingEffort: "plan" }));
    expect(config.mode).toBe("plan");
  });

  it("sets mode to 'ask' for thinkingEffort=ask", () => {
    const config = buildCursorLocalConfig(base({ thinkingEffort: "ask" }));
    expect(config.mode).toBe("ask");
  });

  it("normalizes uppercase PLAN to plan", () => {
    const config = buildCursorLocalConfig(base({ thinkingEffort: "PLAN" }));
    expect(config.mode).toBe("plan");
  });

  it("normalizes mixed-case Ask to ask", () => {
    const config = buildCursorLocalConfig(base({ thinkingEffort: "Ask" }));
    expect(config.mode).toBe("ask");
  });

  it("omits mode for unknown thinkingEffort value", () => {
    const config = buildCursorLocalConfig(base({ thinkingEffort: "high" }));
    expect(config).not.toHaveProperty("mode");
  });

  it("omits mode when thinkingEffort is empty", () => {
    const config = buildCursorLocalConfig(base({ thinkingEffort: "" }));
    expect(config).not.toHaveProperty("mode");
  });
});

// ============================================================================
// Conditional fields
// ============================================================================

describe("buildCursorLocalConfig — conditional fields", () => {
  it("sets cwd when provided", () => {
    const config = buildCursorLocalConfig(base({ cwd: "/home/user/project" }));
    expect(config.cwd).toBe("/home/user/project");
  });

  it("omits cwd when empty", () => {
    const config = buildCursorLocalConfig(base({ cwd: "" }));
    expect(config).not.toHaveProperty("cwd");
  });

  it("sets instructionsFilePath when provided", () => {
    const config = buildCursorLocalConfig(base({ instructionsFilePath: "/path/to/instructions.md" }));
    expect(config.instructionsFilePath).toBe("/path/to/instructions.md");
  });

  it("sets promptTemplate when provided", () => {
    const config = buildCursorLocalConfig(base({ promptTemplate: "Do {{task}}" }));
    expect(config.promptTemplate).toBe("Do {{task}}");
  });

  it("maps bootstrapPrompt to bootstrapPromptTemplate", () => {
    const config = buildCursorLocalConfig(base({ bootstrapPrompt: "Bootstrap me" }));
    expect(config.bootstrapPromptTemplate).toBe("Bootstrap me");
  });

  it("sets command when provided", () => {
    const config = buildCursorLocalConfig(base({ command: "/usr/local/bin/cursor" }));
    expect(config.command).toBe("/usr/local/bin/cursor");
  });

  it("parses extraArgs as comma-separated list", () => {
    const config = buildCursorLocalConfig(base({ extraArgs: "--verbose, --debug" }));
    expect(config.extraArgs).toEqual(["--verbose", "--debug"]);
  });

  it("omits extraArgs when empty", () => {
    const config = buildCursorLocalConfig(base({ extraArgs: "" }));
    expect(config).not.toHaveProperty("extraArgs");
  });
});

// ============================================================================
// envVars / envBindings
// ============================================================================

describe("buildCursorLocalConfig — environment variables", () => {
  it("parses KEY=VALUE pairs from envVars", () => {
    const config = buildCursorLocalConfig(base({ envVars: "FOO=bar\nBAZ=qux" }));
    const env = config.env as Record<string, unknown>;
    expect(env["FOO"]).toEqual({ type: "plain", value: "bar" });
    expect(env["BAZ"]).toEqual({ type: "plain", value: "qux" });
  });

  it("ignores comment lines in envVars", () => {
    const config = buildCursorLocalConfig(base({ envVars: "# comment\nFOO=1" }));
    const env = config.env as Record<string, unknown>;
    expect(Object.keys(env)).toHaveLength(1);
    expect(env["FOO"]).toBeDefined();
  });

  it("envBindings take priority over envVars for same key", () => {
    const config = buildCursorLocalConfig(
      base({
        envBindings: { FOO: { type: "plain", value: "from-bindings" } },
        envVars: "FOO=from-legacy",
      })
    );
    const env = config.env as Record<string, { value: string }>;
    expect(env["FOO"].value).toBe("from-bindings");
  });

  it("stores secret_ref binding", () => {
    const config = buildCursorLocalConfig(
      base({
        envBindings: {
          API_KEY: { type: "secret_ref", secretId: "secret-abc" },
        },
      })
    );
    const env = config.env as Record<string, unknown>;
    expect(env["API_KEY"]).toEqual({ type: "secret_ref", secretId: "secret-abc" });
  });

  it("omits env field when no variables set", () => {
    const config = buildCursorLocalConfig(base({ envVars: "", envBindings: {} }));
    expect(config).not.toHaveProperty("env");
  });
});

// ============================================================================
// adapterFallbackChain
// ============================================================================

describe("buildCursorLocalConfig — adapterFallbackChain", () => {
  it("sets adapterFallbackChain when provided", () => {
    const chain = [{ adapterType: "claude_local" }];
    const config = buildCursorLocalConfig(base({ adapterFallbackChain: chain }));
    expect(config.adapterFallbackChain).toEqual(chain);
  });

  it("omits adapterFallbackChain when empty array", () => {
    const config = buildCursorLocalConfig(base({ adapterFallbackChain: [] }));
    expect(config).not.toHaveProperty("adapterFallbackChain");
  });

  it("does not set rateLimitFallback even when fallbackToCodexOnRateLimit is true", () => {
    // cursor-local does not support rateLimitFallback (unlike claude-local)
    const config = buildCursorLocalConfig(
      base({ fallbackToCodexOnRateLimit: true, adapterFallbackChain: [] })
    );
    expect(config).not.toHaveProperty("rateLimitFallback");
  });
});
