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
    expect(composerEfforts(agent("codex_local"), "custom-private-model", [])).toEqual([]);
    expect(composerEfforts(agent("opencode_local"), "openrouter/x/y", ["openrouter/x/y"])).toEqual([]);
    expect(composerEfforts(agent("kimi_local"), "kimi-code/k3", ["kimi-code/k3"])).toEqual(["low", "high", "max"]);
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
    expect(mergeComposerRunSettings(previous, "claude_local", { model: "claude-opus", effort: "high", fast: false, daybreak: false }))
      .toEqual({ adapterConfig: { chrome: true, model: "claude-opus", effort: "high" }, useProjectWorkspace: true });
    const reset = mergeComposerRunSettings(previous, "claude_local", { model: null, effort: null, fast: false, daybreak: false });
    expect(reset).toEqual({ adapterConfig: { chrome: true }, useProjectWorkspace: true });
    expect(readComposerRunSettings(reset, "claude_local")).toEqual({ model: null, effort: null, fast: false, daybreak: false });
    expect(readComposerRunSettings({ adapterConfig: { reasoningEffort: "xhigh" } }, "codex_local").effort).toBe("xhigh");
    expect(readComposerRunSettings({ adapterConfig: { daybreakEnabled: true } }, "codex_local").daybreak).toBe(true);
    expect(mergeComposerRunSettings(previous, "codex_local", { model: "gpt-6-astra", effort: "ultra", fast: true, daybreak: true }, true))
      .toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra", fastMode: true, daybreakEnabled: true } });
  });
});
