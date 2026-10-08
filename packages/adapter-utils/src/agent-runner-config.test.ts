import { describe, expect, it } from "vitest";
import { agentHarnessType } from "@paperclipai/shared";
import { resolveAgentRunnerConfig } from "./agent-runner-config.js";

describe("new agent runner selection", () => {
  it.each([
    ["codex_local", "codex", undefined],
    ["claude_local", "acpx", "claude"],
    ["opencode_local", "opencode", undefined],
    ["grok_local", "acpx", "grok"],
    ["cursor", "acpx", "cursor"],
  ])("defaults %s to its qualified profile and preserves credentials", (adapterType, provider, acpxAgent) => {
    const env = { KEY: { type: "secret_ref", secretId: "secret", version: "latest" } };
    const result = resolveAgentRunnerConfig({ adapterType, adapterConfig: { model: "provider/model", env, cwd: "/work" } });
    expect(result).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider, model: "provider/model", env, cwd: "/work" } });
    expect(result.adapterConfig.acpxAgent).toBe(acpxAgent);
    expect(agentHarnessType(result.adapterType, result.adapterConfig)).toBe(adapterType);
    expect(resolveAgentRunnerConfig(result)).toEqual(result);
  });

  it.each(["pi_local", "gemini_local", "kimi_local", "hermes_local", "cursor_cloud", "http", "custom_plugin"])("preserves %s", adapterType => {
    expect(resolveAgentRunnerConfig({ adapterType, adapterConfig: { custom: 1 } })).toEqual({ adapterType, adapterConfig: { custom: 1 } });
  });

  it("preserves an explicit legacy choice and external override", () => {
    const input = { adapterType: "codex_local", adapterConfig: { command: "/custom/codex" } };
    expect(resolveAgentRunnerConfig({ ...input, runner: "legacy" })).toEqual(input);
    expect(resolveAgentRunnerConfig({ ...input, nativeSupported: false })).toEqual(input);
    expect(() => resolveAgentRunnerConfig({ ...input, runner: "paperclip", nativeSupported: false })).toThrow("unavailable");
  });

  it("preserves OpenCode provider models and company-secret bindings without mutating the input", () => {
    const input = {
      adapterType: "opencode_local",
      adapterConfig: {
        model: "anthropic/claude-sonnet-4-6",
        env: Object.fromEntries(["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].map(key => [key, {
          type: "secret_ref", secretId: `company-secret-${key}`, version: "latest",
        }])),
      },
    };
    const original = structuredClone(input);
    const resolved = resolveAgentRunnerConfig(input);
    expect(resolved).toMatchObject({
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: input.adapterConfig.model, env: original.adapterConfig.env },
    });
    expect(input).toEqual(original);
    expect(resolveAgentRunnerConfig(resolved)).toEqual(resolved);
  });

  it("does not drop custom behavior or weaken explicit permission settings", () => {
    for (const adapterConfig of [{ command: "/custom/codex" }, { extraArgs: ["--custom"] }, { dangerouslyBypassApprovalsAndSandbox: false }]) {
      expect(() => resolveAgentRunnerConfig({ adapterType: "codex_local", adapterConfig })).toThrow("legacy runner");
    }
  });

  it("keeps Codex effort and provider-specific defaults", () => {
    expect(resolveAgentRunnerConfig({ adapterType: "codex_local", adapterConfig: { modelReasoningEffort: "high" } }).adapterConfig.modelReasoningEffort).toBe("high");
    expect(resolveAgentRunnerConfig({ adapterType: "grok_local" }).adapterConfig.model).toBe("grok-4.7");
    expect(resolveAgentRunnerConfig({ adapterType: "opencode_local" }).adapterConfig.model).toContain("/");
    expect(() => resolveAgentRunnerConfig({ adapterType: "cursor" })).toThrow("Choose a Cursor model");
  });

  it("does not reinterpret managed or unknown native providers as Codex", () => {
    expect(agentHarnessType("paperclip_runner", { provider: "claude_managed" })).toBe("claude_managed");
    expect(agentHarnessType("paperclip_runner", { provider: "future" })).toBe("future");
    expect(() => resolveAgentRunnerConfig({ adapterType: "paperclip_runner", adapterConfig: { provider: "aws_agentcore" }, runner: "legacy" })).toThrow("no legacy runner");
  });
});
