import { describe, expect, it } from "vitest";
import { providerDisplayName } from "./utils.js";

describe("providerDisplayName", () => {
  it("formats standard providers correctly", () => {
    expect(providerDisplayName("anthropic")).toBe("Anthropic");
    expect(providerDisplayName("openai")).toBe("OpenAI");
    expect(providerDisplayName("openrouter")).toBe("OpenRouter");
    expect(providerDisplayName("google")).toBe("Google");
  });

  it("formats ollama and ollama-cloud properly", () => {
    expect(providerDisplayName("ollama")).toBe("Ollama");
    expect(providerDisplayName("ollama-cloud")).toBe("Ollama Cloud");
  });

  it("handles case-insensitivity and fallbacks", () => {
    expect(providerDisplayName("Ollama-Cloud")).toBe("Ollama Cloud");
    expect(providerDisplayName("custom-unknown-provider")).toBe("custom-unknown-provider");
  });
});
