import { describe, expect, it } from "vitest";
import { adapterSupportsAiConnections, isAiConnectionCompatible } from "./index.js";

describe("adapterSupportsAiConnections", () => {
  it("returns true for adapters supported by AI connection providers", () => {
    expect(adapterSupportsAiConnections("claude_local")).toBe(true);
    expect(adapterSupportsAiConnections("codex_local")).toBe(true);
    expect(adapterSupportsAiConnections("opencode_local")).toBe(true);
    expect(adapterSupportsAiConnections("grok_local")).toBe(true);
    expect(adapterSupportsAiConnections("agy_local")).toBe(true);
    expect(adapterSupportsAiConnections("gemini_local")).toBe(true);
  });

  it("handles paperclip_runner with supported and unsupported providers", () => {
    expect(adapterSupportsAiConnections("paperclip_runner", "claude")).toBe(true);
    expect(adapterSupportsAiConnections("paperclip_runner", "acpx", "claude")).toBe(true);
    expect(adapterSupportsAiConnections("paperclip_runner", "acpx", "grok")).toBe(true);
    expect(adapterSupportsAiConnections("paperclip_runner", "codex")).toBe(true);
    expect(adapterSupportsAiConnections("paperclip_runner", "opencode")).toBe(true);
    expect(adapterSupportsAiConnections("paperclip_runner", "custom")).toBe(false);
  });

  it("returns false for adapters that do not use AI connections", () => {
    expect(adapterSupportsAiConnections("kimi_local")).toBe(false);
    expect(adapterSupportsAiConnections("cursor")).toBe(false);
    expect(adapterSupportsAiConnections("process")).toBe(false);
    expect(adapterSupportsAiConnections("http")).toBe(false);
  });
});
