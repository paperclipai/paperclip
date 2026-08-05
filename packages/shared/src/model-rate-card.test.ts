import { describe, expect, it } from "vitest";
import {
  deriveRateCardCents,
  normalizeRateCardModelId,
  resolveModelRate,
} from "./model-rate-card.js";

const AUG_2026 = new Date("2026-08-31T23:59:59.999Z");
const SEP_2026 = new Date("2026-09-01T00:00:00.000Z");

describe("resolveModelRate", () => {
  it("returns published per-million rates for a flat-priced model", () => {
    expect(resolveModelRate("claude-opus-4-8")).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(resolveModelRate("claude-haiku-4-5")).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it("prices Sonnet 5 at the introductory rate through 2026-08-31 UTC", () => {
    expect(resolveModelRate("claude-sonnet-5", AUG_2026)).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
  });

  it("prices Sonnet 5 at the standard rate from 2026-09-01 UTC", () => {
    expect(resolveModelRate("claude-sonnet-5", SEP_2026)).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it("returns null for a model with no published rate", () => {
    expect(resolveModelRate("minimax/MiniMax-M3")).toBeNull();
    expect(resolveModelRate("auto")).toBeNull();
    expect(resolveModelRate("")).toBeNull();
  });
});

describe("normalizeRateCardModelId", () => {
  it("strips Bedrock provider and region prefixes", () => {
    expect(normalizeRateCardModelId("anthropic.claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeRateCardModelId("us.anthropic.claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeRateCardModelId("eu.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeRateCardModelId("apac.anthropic.claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("strips gateway-style provider prefixes", () => {
    expect(normalizeRateCardModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("strips a Vertex @-pinned snapshot", () => {
    expect(normalizeRateCardModelId("claude-opus-4-5@20251101")).toBe("claude-opus-4-5");
  });

  it("strips a trailing 8-digit date snapshot", () => {
    expect(normalizeRateCardModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeRateCardModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
  });

  it("maps dotted version forms onto dashed ids", () => {
    expect(normalizeRateCardModelId("claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(normalizeRateCardModelId("CLAUDE-SONNET-4.6")).toBe("claude-sonnet-4-6");
  });

  it("strips a context-window bracket suffix", () => {
    // Observed in the live ledger; 1M-context Opus bills at standard rates.
    expect(normalizeRateCardModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
  });

  it("lowercases and trims", () => {
    expect(normalizeRateCardModelId("  Claude-Opus-4-8  ")).toBe("claude-opus-4-8");
  });
});

describe("deriveRateCardCents", () => {
  it("computes per-MILLION-token math across all four token classes", () => {
    // 1M input @ $5 + 1M cache read @ $0.50 + 1M output @ $25 + 1M cache write
    // @ $6.25 = $36.75 = 3675 cents.
    expect(
      deriveRateCardCents("claude-opus-4-8", {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(3_675);
  });

  it("does not treat per-million rates as per-token", () => {
    // A single million-token dimension must not produce a million-dollar figure.
    expect(
      deriveRateCardCents("claude-haiku-4-5", {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(100);
  });

  it("prices a realistic subscription run that the CLI reported as $0", () => {
    // The bug this guards: hundreds of millions of tokens booked at zero cash.
    const derived = deriveRateCardCents("claude-opus-4-8", {
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
      cacheWriteTokens: 1_000_000,
    });
    // $13.66 input + $1.32 cache read + $0.82 output + $6.25 cache write.
    expect(derived).toBeGreaterThan(0);
    expect(derived).toBe(2_205);
  });

  it("honours the Sonnet 5 dated boundary", () => {
    const tokens = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };
    expect(deriveRateCardCents("claude-sonnet-5", tokens, AUG_2026)).toBe(1_200);
    expect(deriveRateCardCents("claude-sonnet-5", tokens, SEP_2026)).toBe(1_800);
  });

  it("returns 0 - not null - for a priced sub-cent token count", () => {
    const derived = deriveRateCardCents("claude-haiku-4-5", {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
    });
    expect(derived).toBe(0);
    expect(derived).not.toBeNull();
  });

  it("returns null for an unknown model rather than defaulting to zero", () => {
    expect(
      deriveRateCardCents("some-unlisted-model", {
        inputTokens: 5_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      }),
    ).toBeNull();
  });

  it("treats a missing cacheWriteTokens as zero", () => {
    expect(
      deriveRateCardCents("claude-opus-4-8", {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(500);
  });

  it("never returns a negative figure", () => {
    expect(
      deriveRateCardCents("claude-opus-4-8", {
        inputTokens: -1_000_000,
        cachedInputTokens: -5,
        outputTokens: Number.NaN,
        cacheWriteTokens: -10,
      }),
    ).toBe(0);
  });

  it("prices every normalised alias the same as its canonical id", () => {
    const tokens = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
    const canonical = deriveRateCardCents("claude-opus-4-8", tokens);
    for (const alias of [
      "us.anthropic.claude-opus-4-8",
      "anthropic/claude-opus-4-8",
      "claude-opus-4.8",
      "claude-opus-4-8[1m]",
      "claude-opus-4-8-20260115",
    ]) {
      expect(deriveRateCardCents(alias, tokens)).toBe(canonical);
    }
  });
});
