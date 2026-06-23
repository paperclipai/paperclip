import { describe, expect, it } from "vitest";
import {
  estimateTokenMarketValueCents,
  estimateTokenMarketValueUsd,
  inferOpenAiCompatibleBiller,
} from "./billing.js";

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
});

describe("token market value estimates", () => {
  it("estimates OpenAI token usage with cached input tokens", () => {
    expect(
      estimateTokenMarketValueUsd({
        provider: "openai",
        model: "gpt-5.5",
        inputTokens: 100000,
        cachedInputTokens: 50000,
        outputTokens: 1000,
      }),
    ).toBe(0.555);
  });

  it("estimates Claude token usage with cache-read tokens", () => {
    expect(
      estimateTokenMarketValueCents({
        provider: "anthropic",
        model: "claude-sonnet-4-6-20260601",
        inputTokens: 100000,
        cachedInputTokens: 50000,
        outputTokens: 1000,
      }),
    ).toBe(33);
  });

  it("returns null for unknown provider or model pricing", () => {
    expect(
      estimateTokenMarketValueCents({
        provider: "unknown",
        model: "unknown-model",
        inputTokens: 100000,
        cachedInputTokens: 0,
        outputTokens: 1000,
      }),
    ).toBeNull();
  });
});
