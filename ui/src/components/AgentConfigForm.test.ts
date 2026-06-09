import { describe, expect, it } from "vitest";
import { supportsAdapterModelRefresh } from "./AgentConfigForm";

describe("supportsAdapterModelRefresh", () => {
  it("enables the model refresh action for Claude, Codex, and ACPX adapters", () => {
    expect(supportsAdapterModelRefresh("claude_local")).toBe(true);
    expect(supportsAdapterModelRefresh("codex_local")).toBe(true);
    expect(supportsAdapterModelRefresh("acpx_local")).toBe(true);
  });

  it("keeps the refresh action hidden for adapters without a live refresh hook", () => {
    expect(supportsAdapterModelRefresh("opencode_local")).toBe(false);
    expect(supportsAdapterModelRefresh("process")).toBe(false);
  });
});
