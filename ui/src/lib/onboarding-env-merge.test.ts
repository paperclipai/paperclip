import { describe, it, expect } from "vitest";
import type { EnvBinding } from "@paperclipai/shared";
import { mergeAdapterEnv } from "./onboarding-env-merge";

describe("mergeAdapterEnv", () => {
  it("returns undefined when no adapter env, no user env, no force-unset", () => {
    const result = mergeAdapterEnv({
      adapterEnv: undefined,
      userEnv: {},
      adapterType: "codex_local",
      forceUnsetAnthropicApiKey: false,
    });
    expect(result).toBeUndefined();
  });

  it("includes user-provided env vars in the merged output", () => {
    const userEnv: Record<string, EnvBinding> = {
      CLAUDE_CONFIG_DIR: "/Users/test/.claude-paperclip",
    };
    const result = mergeAdapterEnv({
      adapterEnv: undefined,
      userEnv,
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: false,
    });
    expect(result).toEqual({
      CLAUDE_CONFIG_DIR: "/Users/test/.claude-paperclip",
    });
  });

  it("layers user env on top of adapter-built env (user takes precedence)", () => {
    const result = mergeAdapterEnv({
      adapterEnv: {
        ADAPTER_VAR: "adapter-value",
        SHARED_VAR: "from-adapter",
      },
      userEnv: {
        USER_VAR: "user-value",
        SHARED_VAR: "from-user",
      },
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: false,
    });
    expect(result).toEqual({
      ADAPTER_VAR: "adapter-value",
      USER_VAR: "user-value",
      SHARED_VAR: "from-user",
    });
  });

  it("force-unsets ANTHROPIC_API_KEY for claude_local even if user provided one", () => {
    const result = mergeAdapterEnv({
      adapterEnv: undefined,
      userEnv: { ANTHROPIC_API_KEY: "leaked-user-key" },
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: true,
    });
    expect(result?.ANTHROPIC_API_KEY).toEqual({ type: "plain", value: "" });
  });

  it("does NOT force-unset ANTHROPIC_API_KEY when adapter is not claude_local", () => {
    const result = mergeAdapterEnv({
      adapterEnv: undefined,
      userEnv: { ANTHROPIC_API_KEY: "user-key" },
      adapterType: "codex_local",
      forceUnsetAnthropicApiKey: true,
    });
    expect(result?.ANTHROPIC_API_KEY).toBe("user-key");
  });

  it("does NOT force-unset ANTHROPIC_API_KEY when forceUnsetAnthropicApiKey is false", () => {
    const result = mergeAdapterEnv({
      adapterEnv: undefined,
      userEnv: { ANTHROPIC_API_KEY: "user-key" },
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: false,
    });
    expect(result?.ANTHROPIC_API_KEY).toBe("user-key");
  });

  it("preserves other user env when force-unsetting ANTHROPIC_API_KEY", () => {
    const result = mergeAdapterEnv({
      adapterEnv: undefined,
      userEnv: {
        CLAUDE_CONFIG_DIR: "/path",
        ANTHROPIC_API_KEY: "should-be-cleared",
      },
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: true,
    });
    expect(result).toEqual({
      CLAUDE_CONFIG_DIR: "/path",
      ANTHROPIC_API_KEY: { type: "plain", value: "" },
    });
  });

  it("treats non-object adapter env as empty (handles malformed adapter output)", () => {
    const result = mergeAdapterEnv({
      adapterEnv: "not-an-object" as unknown as Record<string, unknown>,
      userEnv: { USER_VAR: "value" },
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: false,
    });
    expect(result).toEqual({ USER_VAR: "value" });
  });
});
