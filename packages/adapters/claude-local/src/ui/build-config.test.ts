import { describe, expect, it } from "vitest";
import { buildClaudeLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function base(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "claude_local",
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
    workspaceStrategyType: "",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    command: "",
    ...overrides,
  };
}

// ============================================================================
// Always-set fields
// ============================================================================

describe("buildClaudeLocalConfig — always-set fields", () => {
  it("always sets timeoutSec to 0", () => {
    const config = buildClaudeLocalConfig(base());
    expect(config.timeoutSec).toBe(0);
  });

  it("always sets graceSec to 15", () => {
    const config = buildClaudeLocalConfig(base());
    expect(config.graceSec).toBe(15);
  });

  it("always includes maxTurnsPerRun", () => {
    const config = buildClaudeLocalConfig(base({ maxTurnsPerRun: 25 }));
    expect(config.maxTurnsPerRun).toBe(25);
  });

  it("always includes dangerouslySkipPermissions", () => {
    const config = buildClaudeLocalConfig(base({ dangerouslySkipPermissions: true }));
    expect(config.dangerouslySkipPermissions).toBe(true);
  });
});

// ============================================================================
// Conditional fields — only set when truthy
// ============================================================================

describe("buildClaudeLocalConfig — conditional fields", () => {
  it("sets cwd when provided", () => {
    const config = buildClaudeLocalConfig(base({ cwd: "/home/user/project" }));
    expect(config.cwd).toBe("/home/user/project");
  });

  it("omits cwd when empty", () => {
    const config = buildClaudeLocalConfig(base({ cwd: "" }));
    expect(config).not.toHaveProperty("cwd");
  });

  it("sets model when provided", () => {
    const config = buildClaudeLocalConfig(base({ model: "claude-opus-4-6" }));
    expect(config.model).toBe("claude-opus-4-6");
  });

  it("omits model when empty", () => {
    const config = buildClaudeLocalConfig(base({ model: "" }));
    expect(config).not.toHaveProperty("model");
  });

  it("maps thinkingEffort to effort", () => {
    const config = buildClaudeLocalConfig(base({ thinkingEffort: "high" }));
    expect(config.effort).toBe("high");
  });

  it("omits effort when thinkingEffort is empty", () => {
    const config = buildClaudeLocalConfig(base({ thinkingEffort: "" }));
    expect(config).not.toHaveProperty("effort");
  });

  it("sets chrome: true when chrome is truthy", () => {
    const config = buildClaudeLocalConfig(base({ chrome: true }));
    expect(config.chrome).toBe(true);
  });

  it("omits chrome when falsy", () => {
    const config = buildClaudeLocalConfig(base({ chrome: false }));
    expect(config).not.toHaveProperty("chrome");
  });

  it("sets instructionsFilePath when provided", () => {
    const config = buildClaudeLocalConfig(base({ instructionsFilePath: "/path/to/instructions.md" }));
    expect(config.instructionsFilePath).toBe("/path/to/instructions.md");
  });

  it("sets promptTemplate when provided", () => {
    const config = buildClaudeLocalConfig(base({ promptTemplate: "Do {{task}}" }));
    expect(config.promptTemplate).toBe("Do {{task}}");
  });

  it("maps bootstrapPrompt to bootstrapPromptTemplate", () => {
    const config = buildClaudeLocalConfig(base({ bootstrapPrompt: "Bootstrap me" }));
    expect(config.bootstrapPromptTemplate).toBe("Bootstrap me");
  });

  it("sets command when provided", () => {
    const config = buildClaudeLocalConfig(base({ command: "/usr/local/bin/claude" }));
    expect(config.command).toBe("/usr/local/bin/claude");
  });

  it("parses extraArgs as comma-separated list", () => {
    const config = buildClaudeLocalConfig(base({ extraArgs: "--verbose, --debug, --no-color" }));
    expect(config.extraArgs).toEqual(["--verbose", "--debug", "--no-color"]);
  });

  it("omits extraArgs when empty", () => {
    const config = buildClaudeLocalConfig(base({ extraArgs: "" }));
    expect(config).not.toHaveProperty("extraArgs");
  });
});

// ============================================================================
// envVars parsing
// ============================================================================

describe("buildClaudeLocalConfig — envVars (legacy)", () => {
  it("parses KEY=VALUE pairs", () => {
    const config = buildClaudeLocalConfig(base({ envVars: "FOO=bar\nBAZ=qux" }));
    const env = config.env as Record<string, unknown>;
    expect(env).toBeDefined();
    expect(env["FOO"]).toEqual({ type: "plain", value: "bar" });
    expect(env["BAZ"]).toEqual({ type: "plain", value: "qux" });
  });

  it("preserves value with equals sign", () => {
    const config = buildClaudeLocalConfig(base({ envVars: "TOKEN=abc=def=ghi" }));
    const env = config.env as Record<string, { value: string }>;
    expect(env["TOKEN"].value).toBe("abc=def=ghi");
  });

  it("ignores comment lines starting with #", () => {
    const config = buildClaudeLocalConfig(base({ envVars: "# comment\nFOO=1" }));
    const env = config.env as Record<string, unknown>;
    expect(env).not.toHaveProperty("# comment");
    expect(env["FOO"]).toBeDefined();
  });

  it("ignores blank lines in envVars", () => {
    const config = buildClaudeLocalConfig(base({ envVars: "\n\nFOO=1\n\n" }));
    const env = config.env as Record<string, unknown>;
    expect(Object.keys(env)).toHaveLength(1);
  });

  it("ignores entries with invalid key names", () => {
    const config = buildClaudeLocalConfig(base({ envVars: "123BAD=value\nGOOD_KEY=ok" }));
    const env = config.env as Record<string, unknown>;
    expect(env).not.toHaveProperty("123BAD");
    expect(env["GOOD_KEY"]).toBeDefined();
  });

  it("omits env field when envVars is empty and no envBindings", () => {
    const config = buildClaudeLocalConfig(base({ envVars: "", envBindings: {} }));
    expect(config).not.toHaveProperty("env");
  });
});

// ============================================================================
// envBindings (structured)
// ============================================================================

describe("buildClaudeLocalConfig — envBindings", () => {
  it("stores plain string bindings as plain type", () => {
    const config = buildClaudeLocalConfig(base({ envBindings: { MY_VAR: "my-value" } }));
    const env = config.env as Record<string, unknown>;
    expect(env["MY_VAR"]).toEqual({ type: "plain", value: "my-value" });
  });

  it("stores plain object bindings unchanged", () => {
    const config = buildClaudeLocalConfig(
      base({ envBindings: { MY_VAR: { type: "plain", value: "structured" } } })
    );
    const env = config.env as Record<string, unknown>;
    expect(env["MY_VAR"]).toEqual({ type: "plain", value: "structured" });
  });

  it("stores secret_ref bindings with secretId", () => {
    const config = buildClaudeLocalConfig(
      base({
        envBindings: {
          API_KEY: { type: "secret_ref", secretId: "secret-abc", version: "latest" },
        },
      })
    );
    const env = config.env as Record<string, unknown>;
    expect(env["API_KEY"]).toEqual({ type: "secret_ref", secretId: "secret-abc", version: "latest" });
  });

  it("envBindings take priority over envVars for same key", () => {
    const config = buildClaudeLocalConfig(
      base({
        envBindings: { FOO: { type: "plain", value: "from-bindings" } },
        envVars: "FOO=from-legacy",
      })
    );
    const env = config.env as Record<string, { value: string }>;
    expect(env["FOO"].value).toBe("from-bindings");
  });

  it("ignores bindings with invalid key names", () => {
    const config = buildClaudeLocalConfig(base({ envBindings: { "123BAD": "value" } }));
    const env = config.env as Record<string, unknown> | undefined;
    expect(env).toBeUndefined();
  });
});

// ============================================================================
// adapterFallbackChain / rateLimitFallback
// ============================================================================

describe("buildClaudeLocalConfig — fallback chain", () => {
  it("sets adapterFallbackChain when provided", () => {
    const chain = [{ adapterType: "codex_local" }];
    const config = buildClaudeLocalConfig(base({ adapterFallbackChain: chain }));
    expect(config.adapterFallbackChain).toEqual(chain);
  });

  it("omits adapterFallbackChain when empty array", () => {
    const config = buildClaudeLocalConfig(base({ adapterFallbackChain: [] }));
    expect(config).not.toHaveProperty("adapterFallbackChain");
  });

  it("sets rateLimitFallback when fallbackToCodexOnRateLimit is true and no explicit chain", () => {
    const config = buildClaudeLocalConfig(
      base({ fallbackToCodexOnRateLimit: true, adapterFallbackChain: [] })
    );
    expect(config.rateLimitFallback).toEqual({ adapterType: "codex_local" });
  });

  it("does not set rateLimitFallback when adapterFallbackChain is provided", () => {
    const config = buildClaudeLocalConfig(
      base({
        fallbackToCodexOnRateLimit: true,
        adapterFallbackChain: [{ adapterType: "codex_local" }],
      })
    );
    expect(config).not.toHaveProperty("rateLimitFallback");
  });
});

// ============================================================================
// workspaceStrategy
// ============================================================================

describe("buildClaudeLocalConfig — workspaceStrategy", () => {
  it("sets git_worktree strategy when workspaceStrategyType is git_worktree", () => {
    const config = buildClaudeLocalConfig(
      base({
        workspaceStrategyType: "git_worktree",
        workspaceBaseRef: "main",
        workspaceBranchTemplate: "agent/{{issue}}",
        worktreeParentDir: "/tmp/worktrees",
      })
    );
    expect(config.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "main",
      branchTemplate: "agent/{{issue}}",
      worktreeParentDir: "/tmp/worktrees",
    });
  });

  it("omits optional workspace fields when not set", () => {
    const config = buildClaudeLocalConfig(
      base({ workspaceStrategyType: "git_worktree" })
    );
    const ws = config.workspaceStrategy as Record<string, unknown>;
    expect(ws.type).toBe("git_worktree");
    expect(ws).not.toHaveProperty("baseRef");
    expect(ws).not.toHaveProperty("branchTemplate");
    expect(ws).not.toHaveProperty("worktreeParentDir");
  });

  it("omits workspaceStrategy when not git_worktree", () => {
    const config = buildClaudeLocalConfig(base({ workspaceStrategyType: "" }));
    expect(config).not.toHaveProperty("workspaceStrategy");
  });
});

// ============================================================================
// runtimeServicesJson
// ============================================================================

describe("buildClaudeLocalConfig — runtimeServicesJson", () => {
  it("sets workspaceRuntime when valid JSON with services array", () => {
    const services = { services: [{ type: "postgres", port: 5432 }] };
    const config = buildClaudeLocalConfig(
      base({ runtimeServicesJson: JSON.stringify(services) })
    );
    expect(config.workspaceRuntime).toEqual(services);
  });

  it("omits workspaceRuntime when runtimeServicesJson is empty", () => {
    const config = buildClaudeLocalConfig(base({ runtimeServicesJson: "" }));
    expect(config).not.toHaveProperty("workspaceRuntime");
  });

  it("omits workspaceRuntime when parsed object has no services array", () => {
    const config = buildClaudeLocalConfig(
      base({ runtimeServicesJson: JSON.stringify({ notServices: true }) })
    );
    expect(config).not.toHaveProperty("workspaceRuntime");
  });

  it("omits workspaceRuntime when JSON is invalid", () => {
    const config = buildClaudeLocalConfig(base({ runtimeServicesJson: "not-json" }));
    expect(config).not.toHaveProperty("workspaceRuntime");
  });
});
