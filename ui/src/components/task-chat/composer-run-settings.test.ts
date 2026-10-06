import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  composerCatalogProvider, composerDefaultModel, composerEfforts, composerFastAvailable, mergeComposerRunSettings,
  readComposerRunSettings, supportsComposerModel,
} from "./composer-run-settings";

const agent = (adapterType: Agent["adapterType"], provider?: string) => ({
  adapterType, adapterConfig: provider ? { provider } : {},
}) as Agent;

describe("composer run settings", () => {
  it("resolves known adapter defaults without guessing local CLI settings", () => {
    expect(composerDefaultModel(agent("claude_local"))).toBe("");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { model: "claude-opus-5" } })).toBe("claude-opus-5");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { env: { ANTHROPIC_MODEL: "claude-sonnet-5" } } })).toBe("claude-sonnet-5");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } } })).toBe("");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { env: { CLAUDE_CODE_USE_VERTEX: "1" } } })).toBe("");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { env: { ANTHROPIC_MODEL: { type: "secret_ref", secretId: "model-secret" } } } })).toBe("");
    expect(composerDefaultModel({ ...agent("codex_local"), adapterConfig: { model: " private-codex " } })).toBe("private-codex");
    expect(composerDefaultModel(agent("codex_local"))).toBe("");
    expect(composerDefaultModel(agent("paperclip_runner", "codex"))).toBe("gpt-5.6-sol");
    expect(composerDefaultModel(agent("grok_local"))).toBe("grok-build");
    expect(composerDefaultModel(undefined)).toBe("");
  });
  it("shows only effort levels known for the selected harness and model", () => {
    expect(composerEfforts(agent("codex_local"), "gpt-6-astra", [])).toContain("ultra");
    expect(composerEfforts(agent("paperclip_runner", "codex"), "gpt-6-astra", [])).toContain("ultra");
    expect(composerEfforts(agent("paperclip_runner", "opencode"), "gpt-6-astra", [])).toEqual([]);
    expect(composerEfforts(agent("codex_local"), "custom-private-model", [])).toEqual([]);
    expect(composerEfforts(agent("opencode_local"), "openrouter/x/y", ["openrouter/x/y"])).toEqual([]);
    expect(composerEfforts(agent("claude_local"), "claude-sonnet-5", ["claude-sonnet-5"])).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(composerEfforts(agent("claude_local"), "claude-haiku-4-5", ["claude-haiku-4-5"])).toEqual([]);
    expect(composerEfforts(agent("grok_local"), "grok-4.7", ["grok-4.7"])).toEqual(["low", "medium", "high", "xhigh"]);
    expect(composerEfforts(agent("grok_local"), "grok-4.7", [])).toEqual([]);
    expect(composerEfforts(agent("grok_local"), "", ["grok-build"])).toEqual(["low", "medium", "high"]);
    expect(composerEfforts(agent("kimi_local"), "kimi-code/k3", ["kimi-code/k3"])).toEqual([]);
    expect(composerEfforts({ ...agent("kimi_local"), adapterConfig: { engine: "cli" } }, "kimi-code/k3", ["kimi-code/k3"])).toEqual(["low", "high", "max"]);
    expect(composerEfforts({ ...agent("kimi_local"), adapterConfig: { engine: " CLI " } }, "", ["kimi-code/kimi-for-coding"])).toEqual(["low", "high", "max"]);
    expect(composerEfforts(agent("kimi_local"), "kimi-code/kimi-for-coding-highspeed", ["kimi-code/kimi-for-coding-highspeed"])).toEqual([]);
    expect(composerFastAvailable(agent("codex_local"), "gpt-6-astra")).toBe(true);
    expect(composerFastAvailable(agent("codex_local"), "custom-private-model")).toBe(false);
    expect(supportsComposerModel(agent("process"))).toBe(false);
    expect(composerCatalogProvider({ ...agent("opencode_local"), adapterConfig: { model: "openrouter/qwen/qwen3-coder-next" } })).toBe("openrouter");
  });

  it("preserves unrelated task overrides while changing or resetting run settings", () => {
    const previous = { adapterConfig: { chrome: true, model: "old", effort: "low" }, useProjectWorkspace: true };
    expect(mergeComposerRunSettings(previous, "claude_local", { model: "claude-opus", effort: "high", fast: false }))
      .toEqual({ adapterConfig: { chrome: true, model: "claude-opus", effort: "high" }, useProjectWorkspace: true });
    const reset = mergeComposerRunSettings(previous, "claude_local", { model: null, effort: null, fast: false });
    expect(reset).toEqual({ adapterConfig: { chrome: true }, useProjectWorkspace: true });
    expect(readComposerRunSettings(reset, "claude_local")).toEqual({ model: null, effort: null, fast: false });
    expect(readComposerRunSettings({ adapterConfig: { reasoningEffort: "xhigh" } }, "codex_local").effort).toBe("xhigh");
    expect(mergeComposerRunSettings(previous, "codex_local", { model: "gpt-6-astra", effort: "ultra", fast: true }, true))
      .toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra", fastMode: true } });
    const runner = mergeComposerRunSettings(null, "paperclip_runner", { model: "gpt-6-astra", effort: "ultra", fast: false });
    expect(runner).toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra" } });
    expect(readComposerRunSettings(runner, "paperclip_runner").effort).toBe("ultra");
    const grok = mergeComposerRunSettings(null, "grok_local", { model: "grok-4.7", effort: "xhigh", fast: false });
    expect(grok).toEqual({ adapterConfig: { model: "grok-4.7", reasoningEffort: "xhigh" } });
    expect(readComposerRunSettings(grok, "grok_local").effort).toBe("xhigh");
  });
});
