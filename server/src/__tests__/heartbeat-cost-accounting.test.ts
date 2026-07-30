import { describe, expect, it } from "vitest";
import { deriveRateCardCents } from "@paperclipai/shared";
import {
  resolveCacheAdjustedCostUsd,
  resolveLedgerCostStatus,
} from "../services/heartbeat.js";

describe("heartbeat cost accounting", () => {
  it("marks token-bearing usage with no rate card and no reported cost as unpriced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: null,
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
      rateCardCents: null,
    })).toBe("unpriced");
  });

  it("marks reported CLI cost as priced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 1.25,
      inputTokens: 2_090,
      cachedInputTokens: 300_000,
      outputTokens: 77_000,
      rateCardCents: 2_205,
    })).toBe("reported");
  });

  it("uses an explicit cache-adjusted provider cost when available", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 1.25,
      cacheAdjustedCostUsd: 0.92,
    })).toBe(0.92);
  });

  it("attributes provider-reported billed cost as cache-adjusted by default", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 1.25,
      cacheAdjustedCostUsd: null,
    })).toBe(1.25);
  });

  it("does not attribute invalid or unavailable costs", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: null,
      cacheAdjustedCostUsd: Number.NaN,
    })).toBeNull();
  });

  it("prices a run that only reports a cache-adjusted cost", () => {
    const billedCostUsd = resolveCacheAdjustedCostUsd({
      costUsd: null,
      cacheAdjustedCostUsd: 0.42,
    });
    expect(billedCostUsd).toBe(0.42);
    expect(resolveLedgerCostStatus({
      costUsd: billedCostUsd,
      inputTokens: 1_000,
      cachedInputTokens: 900_000,
      outputTokens: 5_000,
      rateCardCents: null,
    })).toBe("reported");
  });

  it("bills the discounted amount when both nominal and cache-adjusted costs are reported", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 3.1,
      cacheAdjustedCostUsd: 1.5,
    })).toBe(1.5);
  });

  it("marks a rate-card-priced run with no reported cost as derived", () => {
    expect(resolveLedgerCostStatus({
      costUsd: null,
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
      rateCardCents: 2_205,
    })).toBe("derived");
  });

  it("keeps reported status for a genuinely idle run with no token usage", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      rateCardCents: 0,
    })).toBe("reported");
  });

  it("records a run that burned only cache-write tokens", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 4_096,
      rateCardCents: 3,
    })).toBe("derived");
  });

  it("treats a priced-but-sub-cent run as derived, not unpriced", () => {
    // rateCardCents === 0 means "we priced it and it rounds below a cent",
    // which is honest; only a null rate card is genuinely unpriced.
    expect(resolveLedgerCostStatus({
      costUsd: 0,
      inputTokens: 12,
      cachedInputTokens: 0,
      outputTokens: 3,
      rateCardCents: 0,
    })).toBe("derived");
  });

  // The PHA-1626 invariant. Subscription CLIs emit a numeric 0 rather than
  // null, which used to fall through to "reported" and made hundreds of
  // millions of real tokens indistinguishable from genuinely free work.
  describe("nonzero tokens with a $0 reported cost can never be 'reported'", () => {
    const tokenShapes = [
      { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 },
      { inputTokens: 0, cachedInputTokens: 1, outputTokens: 0 },
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1 },
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 1 },
      { inputTokens: 2_732_577, cachedInputTokens: 2_632_998, outputTokens: 32_644 },
    ];

    for (const tokens of tokenShapes) {
      for (const rateCardCents of [null, 0, 2_205]) {
        for (const costUsd of [0, null, undefined]) {
          it(`tokens=${JSON.stringify(tokens)} rateCard=${rateCardCents} costUsd=${costUsd}`, () => {
            const status = resolveLedgerCostStatus({ ...tokens, costUsd, rateCardCents });
            expect(status).not.toBe("reported");
            expect(status).toBe(rateCardCents == null ? "unpriced" : "derived");
          });
        }
      }
    }
  });

  it("prices a real claude_local subscription run instead of booking it at $0", () => {
    // End-to-end of the fix: the ledger writer derives the rate card from the
    // model + tokens, and that figure is what flips the row off "reported".
    const tokens = {
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
      cacheWriteTokens: 1_000_000,
    };
    const rateCardCents = deriveRateCardCents(
      "claude-opus-4-8",
      tokens,
      new Date("2026-07-29T00:00:00.000Z"),
    );

    expect(rateCardCents).toBe(2_205);
    expect(resolveLedgerCostStatus({ costUsd: 0, ...tokens, rateCardCents })).toBe("derived");
  });

  it("still reports unpriced for an unlisted model on a subscription plan", () => {
    const tokens = { inputTokens: 5_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };
    const rateCardCents = deriveRateCardCents("some-unlisted-model", tokens);

    expect(rateCardCents).toBeNull();
    expect(resolveLedgerCostStatus({ costUsd: 0, ...tokens, rateCardCents })).toBe("unpriced");
  });
});
