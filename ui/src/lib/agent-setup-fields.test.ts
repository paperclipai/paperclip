// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setupEfforts } from "./agent-setup-fields";

describe("model-specific setup efforts", () => {
  it("offers current Claude efforts without offering them on Haiku", () => {
    expect(setupEfforts("claude_local", "claude-fable-5-1")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("claude_local", "claude-sonnet-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("claude_local", "claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("claude_local", "claude-haiku-4-5")).toEqual([]);
  });

  it("offers xhigh on Grok 4.7 and 4.6, with the lower limit on 4.5", () => {
    expect(setupEfforts("grok_local", "grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(setupEfforts("grok_local", "grok-4.6")).toContain("xhigh");
    expect(setupEfforts("grok_local", "grok-4.5")).toEqual(["low", "medium", "high"]);
  });

  it("caps Luna at max while exposing ultra on Sol", () => {
    expect(setupEfforts("codex_local", "gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("codex_local", "gpt-6-sol")).toContain("ultra");
  });

  it("omits separate efforts for effort-suffixed Antigravity models and offers standard tiers otherwise", () => {
    expect(setupEfforts("agy_local", "gemini-3.8-flash-high")).toEqual([]);
    expect(setupEfforts("agy_local", "gemini-3.6-flash-low")).toEqual([]);
    expect(setupEfforts("agy_local", "claude-sonnet-4-6")).toEqual(["low", "medium", "high"]);
    expect(setupEfforts("agy_local", "auto")).toEqual(["low", "medium", "high"]);
    expect(setupEfforts("agy_local", "")).toEqual([]);
    expect(setupEfforts("agy_local")).toEqual([]);
  });
});
