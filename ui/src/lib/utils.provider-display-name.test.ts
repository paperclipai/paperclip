import { describe, expect, it } from "vitest";
import { providerDisplayName } from "./utils";

describe("providerDisplayName", () => {
  it.each([
    ["ollama-cloud", "Ollama Cloud"],
    ["ollama", "Ollama"],
    ["OLLAMA-CLOUD", "Ollama Cloud"],
    ["OLLAMA", "Ollama"],
  ])("displays %s as %s", (provider, name) => {
    expect(providerDisplayName(provider)).toBe(name);
  });

  it.each([
    ["openrouter", "OpenRouter"],
    ["anthropic", "Anthropic"],
    ["custom-provider", "custom-provider"],
    ["", ""],
  ])("preserves the display name for %s", (provider, name) => {
    expect(providerDisplayName(provider)).toBe(name);
  });
});
