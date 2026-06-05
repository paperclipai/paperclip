import { describe, expect, it } from "vitest";
import { classifyCostSource, computeOpenAICompatibleCost, OPENAI_PRICING_USD_PER_MTOK } from "./pricing.js";
import { models as openCodeModels, modelProfiles as openCodeModelProfiles } from "../index.js";

describe("computeOpenAICompatibleCost", () => {
  it("returns positive cost for a known model with non-zero usage", () => {
    const cost = computeOpenAICompatibleCost("openai/gpt-5.5", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    });
    // openai/gpt-5.5: $3/Mtok input + $12/Mtok output = $15.00
    expect(cost).not.toBeNull();
    expect(cost!).toBeCloseTo(15.0, 6);
  });

  it("returns null for an unknown model (fail-safe — preserves existing $0 behavior)", () => {
    const cost = computeOpenAICompatibleCost("openai/gpt-99-nonexistent", {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 1_000,
    });
    expect(cost).toBeNull();
  });

  it("returns null for all-zero usage (guards against false positives on empty runs)", () => {
    const cost = computeOpenAICompatibleCost("openai/gpt-5.5", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBeNull();
  });

  it("returns null when model is null (matches the model || null upstream pattern)", () => {
    const cost = computeOpenAICompatibleCost(null, {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 1_000,
    });
    expect(cost).toBeNull();
  });

  it("matches the expected cost for a realistic Ally-sized run within tolerance", () => {
    // Real sample from BLO-7436 24h audit (2026-05-24 Ally run):
    //   inputTokens: 138_336  →  138336 * 3.0  / 1e6 = $0.4150
    //   cachedInputTokens: 1_400_320  →  1400320 * 0.3  / 1e6 = $0.4201
    //   outputTokens: 5_226  →  5226 * 12.0 / 1e6 = $0.0627
    //   total ≈ $0.8978
    const cost = computeOpenAICompatibleCost("openai/gpt-5.5", {
      inputTokens: 138_336,
      cachedInputTokens: 1_400_320,
      outputTokens: 5_226,
    });
    expect(cost).not.toBeNull();
    // ±10% to absorb table-drift; the asserted shape (positive, single-dollar range) is the load-bearing claim
    expect(cost!).toBeGreaterThan(0.8);
    expect(cost!).toBeLessThan(1.0);
  });

  it("covers every model in the pricing table with a sanity check", () => {
    // Every entry must have a positive output rate (output is always the
    // dominant axis at chat-completion ratios); guards against accidental
    // zero-out during table refresh.
    for (const [model, rate] of Object.entries(OPENAI_PRICING_USD_PER_MTOK)) {
      expect(rate.input, `${model} input`).toBeGreaterThan(0);
      expect(rate.cachedInput, `${model} cachedInput`).toBeGreaterThanOrEqual(0);
      expect(rate.output, `${model} output`).toBeGreaterThan(0);
      expect(rate.output, `${model} output >= input (typical for chat)`).toBeGreaterThanOrEqual(rate.input);
    }
  });

  it("prices gpt-5.3-codex (BLO-9102: the observed $0 hole) with non-zero usage", () => {
    // Regression: gpt-5.3-codex reported costUsd=0 across the whole window
    // because it was absent from the table. Must now estimate a positive cost.
    const cost = computeOpenAICompatibleCost("openai/gpt-5.3-codex", {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 50_000,
    });
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it("BLO-9102 coverage invariant: every advertised opencode model is priced (no silent $0)", () => {
    // Acceptance #3: a model an opencode agent can be configured with must
    // appear in the pricing table, or computeOpenAICompatibleCost returns null
    // and the run silently reports $0. This guards against adding a model to
    // the index.ts allowlist / modelProfiles without a matching price.
    const advertised = new Set<string>();
    for (const m of openCodeModels) advertised.add(m.id);
    for (const profile of openCodeModelProfiles) {
      const model = profile.adapterConfig.model;
      if (typeof model === "string" && model) advertised.add(model);
    }
    const unpriced = [...advertised].filter((m) => !OPENAI_PRICING_USD_PER_MTOK[m]);
    expect(unpriced, `advertised opencode models missing from pricing table: ${unpriced.join(", ")}`).toEqual([]);
  });
});

describe("classifyCostSource", () => {
  it("returns 'list_estimate' when the list-price fallback produced a figure", () => {
    expect(classifyCostSource(0, 0.42)).toBe("list_estimate");
  });

  it("returns 'metered' when opencode reported a real positive cost", () => {
    expect(classifyCostSource(1.23, null)).toBe("metered");
  });

  it("returns 'unknown' when there is neither a meter nor a priced estimate", () => {
    // Zero-usage run, or an unpriced model — the $0 hole the coverage test guards.
    expect(classifyCostSource(0, null)).toBe("unknown");
  });
});
