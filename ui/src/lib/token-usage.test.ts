import { describe, expect, it } from "vitest";
import {
  TOKEN_WEIGHTS,
  formatTokenBreakdown,
  hasTokenUsage,
  weightedTokens,
} from "./token-usage";

describe("weightedTokens", () => {
  it("weights cached reads down and output up", () => {
    expect(
      weightedTokens({
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(100);
    expect(
      weightedTokens({
        inputTokens: 0,
        cachedInputTokens: 100,
        outputTokens: 0,
      }),
    ).toBe(10);
    expect(
      weightedTokens({
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 100,
      }),
    ).toBe(500);
  });

  it("keeps cached input from dominating the figure", () => {
    // Observed shape on a real deployment: cached input is ~96% of raw volume,
    // so an unweighted sum would mostly measure context size rather than work.
    const usage = {
      inputTokens: 38_178_829,
      cachedInputTokens: 990_890_405,
      outputTokens: 8_100_626,
    };
    const raw =
      usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;

    expect(raw).toBeGreaterThan(1_000_000_000);
    // 38,178,829 + 99,089,040.5 + 40,503,130 = 177,770,999.5, rounded half-up.
    expect(weightedTokens(usage)).toBe(177_771_000);
    // The weighted figure must not be dominated by the cached term the way raw is.
    expect(weightedTokens(usage)).toBeLessThan(raw / 5);
  });

  it("rounds to a whole number so tiles never render a fraction", () => {
    expect(
      Number.isInteger(
        weightedTokens({
          inputTokens: 0,
          cachedInputTokens: 5,
          outputTokens: 0,
        }),
      ),
    ).toBe(true);
  });

  it("is zero for an unused period", () => {
    expect(
      weightedTokens({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }),
    ).toBe(0);
  });

  it("matches the exported weights, so UI and enforcement cannot drift", () => {
    const usage = { inputTokens: 7, cachedInputTokens: 30, outputTokens: 2 };
    expect(weightedTokens(usage)).toBe(
      Math.round(
        usage.inputTokens * TOKEN_WEIGHTS.input +
          usage.cachedInputTokens * TOKEN_WEIGHTS.cachedInput +
          usage.outputTokens * TOKEN_WEIGHTS.output,
      ),
    );
  });
});

describe("hasTokenUsage", () => {
  it("is false only when every counter is zero", () => {
    expect(
      hasTokenUsage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }),
    ).toBe(false);
    expect(
      hasTokenUsage({ inputTokens: 0, cachedInputTokens: 1, outputTokens: 0 }),
    ).toBe(true);
    expect(
      hasTokenUsage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 1 }),
    ).toBe(true);
  });
});

describe("formatTokenBreakdown", () => {
  it("labels each component so the headline figure is explainable", () => {
    expect(
      formatTokenBreakdown({
        inputTokens: 38_178_829,
        cachedInputTokens: 990_890_405,
        outputTokens: 8_100_626,
      }),
    ).toBe("38.2M in · 990.9M cached · 8.1M out");
  });

  it("renders small counts without a unit suffix", () => {
    expect(
      formatTokenBreakdown({
        inputTokens: 12,
        cachedInputTokens: 0,
        outputTokens: 4,
      }),
    ).toBe("12 in · 0 cached · 4 out");
  });
});
