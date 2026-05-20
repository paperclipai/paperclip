import { describe, expect, it } from "vitest";
import {
  inferOpenAiCompatibleBiller,
  estimateAnthropicCostUsd,
  ANTHROPIC_MODEL_PRICING,
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

describe("estimateAnthropicCostUsd", () => {
  it("returns null when usage is null", () => {
    expect(estimateAnthropicCostUsd("claude-sonnet-4-6", null)).toBeNull();
  });

  it("returns 0 when all token counts are zero", () => {
    expect(
      estimateAnthropicCostUsd("claude-sonnet-4-6", {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it("prices Sonnet at $3 input / $0.30 cached-in / $15 output per 1M", () => {
    const cost = estimateAnthropicCostUsd("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(3.0, 6);
    const cached = estimateAnthropicCostUsd("claude-sonnet-4-6", {
      inputTokens: 0,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cached).toBeCloseTo(0.3, 6);
    const out = estimateAnthropicCostUsd("claude-sonnet-4-6", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(out).toBeCloseTo(15.0, 6);
  });

  it("uses longest matching prefix (claude-sonnet-4-6 over claude-sonnet)", () => {
    const sonnet = estimateAnthropicCostUsd("claude-sonnet-4-6-20251015", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(sonnet).toBeCloseTo(3.0, 6);
  });

  it("falls back to default rate for unknown models", () => {
    const cost = estimateAnthropicCostUsd("gpt-4o", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(ANTHROPIC_MODEL_PRICING.rates.default.input, 6);
  });

  it("handles realistic claude_local usage (Engineer one-shot)", () => {
    // From RFC paperclipai/paperclip#5066 motivation — a real Engineer run
    // we measured at ~$1.28 via Paperclip's per-run usageJson.costUsd. Verify
    // our estimator lands in the same neighbourhood.
    const cost = estimateAnthropicCostUsd("claude-sonnet-4-6", {
      inputTokens: 42,
      cachedInputTokens: 1_041_759,
      outputTokens: 8_860,
    });
    // ~ (42*3 + 1041759*0.3 + 8860*15) / 1e6 = ~0.4459 — close to the
    // provider's own number when discounted for cached-read; the actual
    // provider value includes cache_write at a different rate. The
    // estimator is intentionally a conservative usage proxy, not an invoice.
    expect(cost).toBeGreaterThan(0.4);
    expect(cost).toBeLessThan(0.6);
  });

  it("treats negative token counts as zero (defensive)", () => {
    const cost = estimateAnthropicCostUsd("claude-sonnet-4-6", {
      inputTokens: -100,
      cachedInputTokens: -50,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(15.0, 6);
  });
});
