import { describe, expect, it } from "vitest";
import { defaultPromptTemplateForAdapter, supportsAdapterModelRefresh } from "./AgentConfigForm";

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

describe("defaultPromptTemplateForAdapter", () => {
  it("returns the Paperclip default prompt template for built-in Paperclip adapters", () => {
    expect(defaultPromptTemplateForAdapter("codex_local")).toContain("Execution contract:");
    expect(defaultPromptTemplateForAdapter("cursor_cloud")).toContain("You are agent {{agent.id}}");
  });

  it("returns the Hermes default prompt template for the Hermes local adapter", () => {
    expect(defaultPromptTemplateForAdapter("hermes_local")).toContain('You are "{{agentName}}"');
    expect(defaultPromptTemplateForAdapter("hermes_local")).toContain("{{paperclipApiUrl}}");
  });

  it("does not invent a default for adapters without a known runtime default", () => {
    expect(defaultPromptTemplateForAdapter("http")).toBeNull();
    expect(defaultPromptTemplateForAdapter("process")).toBeNull();
  });
});
