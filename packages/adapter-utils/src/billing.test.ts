import { describe, expect, it } from "vitest";
import { inferOpenAiCompatibleBiller } from "./billing.js";

describe("inferOpenAiCompatibleBiller", () => {
  it("returns openrouter when OPENROUTER_API_KEY is present", () => {
    expect(
      inferOpenAiCompatibleBiller({ OPENROUTER_API_KEY: "sk-or-123" } as NodeJS.ProcessEnv, "openai"),
    ).toBe("openrouter");
  });

  it("returns openrouter when OPENAI_BASE_URL points at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("returns fallback when no OpenRouter markers are present", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://api.openai.com/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openai");
  });

  it.each(["https://proxy.example/v1", "https://openrouter.ai.example/v1", "https://example.org/openrouter.ai", "http://api.openai.com/v1", "invalid"])("does not apply direct provider prices to %s", (baseUrl) => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_BASE_URL: baseUrl }, "openai")).toBe("unknown");
  });

  it("recognizes each supported base URL override", () => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_API_BASE: "https://proxy.example" })).toBe("unknown");
    expect(inferOpenAiCompatibleBiller({ OPENAI_API_BASE_URL: "https://proxy.example" })).toBe("unknown");
    expect(inferOpenAiCompatibleBiller({}, null)).toBeNull();
  });
});
