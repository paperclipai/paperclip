import { describe, expect, it } from "vitest";
import {
  negotiateProviderCapabilities,
  normalizeProviderModelId,
  parseProviderModelId,
  resolveOpenCodeProvider,
} from "./provider-adapters.js";

describe("opencode provider adapters", () => {
  it("normalizes provider aliases for model configuration resolution", () => {
    expect(normalizeProviderModelId("xai/grok-4")).toBe("grok/grok-4");
    expect(normalizeProviderModelId("google/gemini-2.5-pro")).toBe("gemini/gemini-2.5-pro");
  });

  it("parses provider and model from provider/model id", () => {
    expect(parseProviderModelId("azure/gpt-5.3-codex")).toEqual({
      provider: "azure",
      model: "gpt-5.3-codex",
    });
    expect(parseProviderModelId("not-a-model")).toBeNull();
  });

  it("resolves provider metadata for execution result contract", () => {
    const resolved = resolveOpenCodeProvider({
      modelId: "oai/gpt-5.4",
      env: {},
    });

    expect(resolved.modelId).toBe("openai/gpt-5.4");
    expect(resolved.provider).toBe("openai");
    expect(resolved.biller).toBe("openai");
    expect(resolved.contractVersion).toBe("agentos-agents/v1");
  });

  it("negotiates required capabilities by provider", () => {
    const result = negotiateProviderCapabilities({
      provider: "anthropic",
      required: ["session_resume", "reasoning_variants"],
    });
    expect(result.satisfied).toEqual(["session_resume"]);
    expect(result.missing).toEqual(["reasoning_variants"]);
  });
});
