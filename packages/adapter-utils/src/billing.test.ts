import { describe, expect, it } from "vitest";
import { inferOpenAiCompatibleBiller } from "./billing.js";

describe("inferOpenAiCompatibleBiller", () => {
  it("returns 'openrouter' when OPENROUTER_API_KEY is set", () => {
    expect(inferOpenAiCompatibleBiller({ OPENROUTER_API_KEY: "sk-or-xxx" })).toBe("openrouter");
  });

  it("returns 'openrouter' when OPENAI_BASE_URL contains openrouter.ai", () => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_BASE_URL: "https://openrouter.ai/api/v1" })).toBe("openrouter");
  });

  it("returns 'openrouter' when OPENAI_API_BASE contains openrouter.ai", () => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_API_BASE: "https://openrouter.ai/api/v1" })).toBe("openrouter");
  });

  it("returns 'openrouter' when OPENAI_API_BASE_URL contains openrouter.ai", () => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_API_BASE_URL: "https://openrouter.ai/api/v1" })).toBe("openrouter");
  });

  it("openrouter URL matching is case-insensitive", () => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_BASE_URL: "https://OpenRouter.AI/api/v1" })).toBe("openrouter");
  });

  it("returns default fallback 'openai' when no env vars are set", () => {
    expect(inferOpenAiCompatibleBiller({})).toBe("openai");
  });

  it("returns custom fallback when provided and no env vars match", () => {
    expect(inferOpenAiCompatibleBiller({}, "azure")).toBe("azure");
  });

  it("returns null fallback when provided and no env vars match", () => {
    expect(inferOpenAiCompatibleBiller({}, null)).toBeNull();
  });

  it("OPENROUTER_API_KEY takes precedence over base URL", () => {
    expect(
      inferOpenAiCompatibleBiller({
        OPENROUTER_API_KEY: "sk-or-xxx",
        OPENAI_BASE_URL: "https://api.openai.com",
      }),
    ).toBe("openrouter");
  });

  it("ignores empty OPENROUTER_API_KEY", () => {
    expect(inferOpenAiCompatibleBiller({ OPENROUTER_API_KEY: "   " })).toBe("openai");
  });

  it("ignores OPENAI_BASE_URL that does not contain openrouter.ai", () => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_BASE_URL: "https://api.openai.com" })).toBe("openai");
  });
});
