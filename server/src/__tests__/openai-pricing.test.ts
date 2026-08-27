import { describe, expect, it } from "vitest";

import {
  OPENAI_PRICING_FALLBACK_KEY,
  OPENAI_TOKEN_PRICING,
  priceOpenAiUsageCents,
} from "../services/openai-pricing.ts";

describe("priceOpenAiUsageCents", () => {
  it("returns 0 when there are no tokens", () => {
    expect(
      priceOpenAiUsageCents({
        model: "gpt-5.5",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it("prices a known model using input/cached/output rates", () => {
    // gpt-5: 1.25 / 0.125 / 10.00 USD per 1M tokens.
    // 1_000_000 uncached input -> $1.25, 1_000_000 output -> $10.00 => $11.25 => 1125 cents.
    expect(
      priceOpenAiUsageCents({
        model: "gpt-5",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      }),
    ).toBe(1125);
  });

  it("subtracts cached tokens from input before pricing", () => {
    // gpt-5: input 1.25, cached 0.125 per 1M.
    // inputTokens=1_000_000 of which 400_000 cached:
    //   uncached 600_000 -> 0.75, cached 400_000 -> 0.05 => $0.80 => 80 cents.
    expect(
      priceOpenAiUsageCents({
        model: "gpt-5",
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 0,
      }),
    ).toBe(80);
  });

  it("matches by longest prefix so codex variants resolve to the codex rate", () => {
    // gpt-5.3-codex: 2.00 / 0.20 / 14.00. gpt-5.3-codex-spark must resolve to it.
    const spark = priceOpenAiUsageCents({
      model: "gpt-5.3-codex-spark",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    const codex = priceOpenAiUsageCents({
      model: "gpt-5.3-codex",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(spark).toBe(codex);
    expect(spark).toBe(200); // $2.00
  });

  it("falls back to the gpt-5.5 batch rate for empty or unknown models", () => {
    const fallback = OPENAI_TOKEN_PRICING[OPENAI_PRICING_FALLBACK_KEY];
    expect(OPENAI_PRICING_FALLBACK_KEY).toBe("gpt-5.5");
    // gpt-5.5 batch: 2.50 input per 1M.
    expect(fallback.input).toBe(2.5);

    const empty = priceOpenAiUsageCents({
      model: "",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    const unknown = priceOpenAiUsageCents({
      model: "some-future-model-9000",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    const nullModel = priceOpenAiUsageCents({
      model: null,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });

    expect(empty).toBe(250); // $2.50
    expect(unknown).toBe(250);
    expect(nullModel).toBe(250);
  });

  it("rounds to the nearest cent", () => {
    // gpt-5-nano: output 0.40 per 1M. 12_345 output tokens -> $0.0049380 -> 0.49 cents -> round 0.
    expect(
      priceOpenAiUsageCents({
        model: "gpt-5-nano",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 12_345,
      }),
    ).toBe(0);
    // 1_250_000 output tokens -> $0.50 -> 50 cents.
    expect(
      priceOpenAiUsageCents({
        model: "gpt-5-nano",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 1_250_000,
      }),
    ).toBe(50);
  });

  it("never returns negative cents when cached exceeds reported input", () => {
    expect(
      priceOpenAiUsageCents({
        model: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 500,
        outputTokens: 0,
      }),
    ).toBeGreaterThanOrEqual(0);
  });
});
