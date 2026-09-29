import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  composerCatalogProvider, composerDaybreakAvailable, composerEfforts, composerFastAvailable, mergeComposerRunSettings,
  readComposerRunSettings, supportsComposerModel,
} from "./composer-run-settings";

const agent = (adapterType: Agent["adapterType"], provider?: string) => ({
  adapterType, adapterConfig: provider ? { provider } : {},
}) as Agent;

describe("composer run settings", () => {
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
    expect(composerDaybreakAvailable(agent("codex_local"))).toBe(true);
    expect(composerDaybreakAvailable(agent("claude_local"))).toBe(false);
    expect(supportsComposerModel(agent("process"))).toBe(false);
    expect(composerCatalogProvider({ ...agent("opencode_local"), adapterConfig: { model: "openrouter/qwen/qwen3-coder-next" } })).toBe("openrouter");
  });

  it("preserves unrelated task overrides while changing or resetting run settings", () => {
    const previous = { adapterConfig: { chrome: true, model: "old", effort: "low" }, useProjectWorkspace: true };
    expect(mergeComposerRunSettings(previous, "claude_local", { model: "claude-opus", effort: "high", fast: false, daybreak: false, daybreakOverride: "inherit" }))
      .toEqual({ adapterConfig: { chrome: true, model: "claude-opus", effort: "high" }, useProjectWorkspace: true });
    const reset = mergeComposerRunSettings(previous, "claude_local", { model: null, effort: null, fast: false, daybreak: false, daybreakOverride: "inherit" });
    expect(reset).toEqual({ adapterConfig: { chrome: true }, useProjectWorkspace: true });
    expect(readComposerRunSettings(reset, "claude_local")).toEqual({ model: null, effort: null, fast: false, daybreak: false, daybreakOverride: "inherit" });
    expect(readComposerRunSettings({ adapterConfig: { reasoningEffort: "xhigh" } }, "codex_local").effort).toBe("xhigh");
    expect(readComposerRunSettings({ adapterConfig: { daybreakEnabled: true } }, "codex_local")).toMatchObject({ daybreak: true, daybreakOverride: "enabled" });
    expect(readComposerRunSettings(null, "codex_local", { daybreakEnabled: true })).toMatchObject({ daybreak: true, daybreakOverride: "inherit" });
    expect(readComposerRunSettings({ adapterConfig: { daybreakEnabled: false } }, "codex_local", { daybreakEnabled: true })).toMatchObject({ daybreak: false, daybreakOverride: "disabled" });
    expect(mergeComposerRunSettings(previous, "codex_local", { model: "gpt-6-astra", effort: "ultra", fast: true, daybreak: true, daybreakOverride: "enabled" }, true))
      .toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra", fastMode: true, daybreakEnabled: true } });
    expect(mergeComposerRunSettings(null, "codex_local", { model: null, effort: null, fast: false, daybreak: false, daybreakOverride: "inherit" }, false, { daybreakEnabled: true }))
      .toBeNull();
    expect(mergeComposerRunSettings(null, "codex_local", { model: null, effort: null, fast: false, daybreak: false, daybreakOverride: "disabled" }, false, { daybreakEnabled: true }))
      .toEqual({ adapterConfig: { daybreakEnabled: false } });
    expect(mergeComposerRunSettings(previous, "codex_local", { model: "gpt-6-astra", effort: "ultra", fast: true, daybreak: false, daybreakOverride: "inherit" }, true))
      .toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra", fastMode: true } });
    const runner = mergeComposerRunSettings(null, "paperclip_runner", { model: "gpt-6-astra", effort: "ultra", fast: false, daybreak: false, daybreakOverride: "inherit" });
    expect(runner).toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra" } });
    expect(readComposerRunSettings(runner, "paperclip_runner").effort).toBe("ultra");
    const grok = mergeComposerRunSettings(null, "grok_local", { model: "grok-4.7", effort: "xhigh", fast: false, daybreak: false, daybreakOverride: "inherit" });
    expect(grok).toEqual({ adapterConfig: { model: "grok-4.7", reasoningEffort: "xhigh" } });
    expect(readComposerRunSettings(grok, "grok_local").effort).toBe("xhigh");
  });
});
