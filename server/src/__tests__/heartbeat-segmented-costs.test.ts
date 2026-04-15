import { describe, expect, it } from "vitest";
import {
  normalizeLedgerBillingType,
  resolveLedgerBiller,
  normalizeBilledCostCents,
  normalizeUsageTotals,
} from "../services/heartbeat.js";
import type { ExecutionSegment, AdapterExecutionResult } from "../adapters/index.js";

describe("resolveLedgerBiller", () => {
  it("returns biller when present", () => {
    expect(resolveLedgerBiller({ biller: "openai", provider: "azure" })).toBe("openai");
  });

  it("falls back to provider when biller is absent", () => {
    expect(resolveLedgerBiller({ biller: null, provider: "anthropic" })).toBe("anthropic");
  });

  it("falls back to provider when biller is empty string", () => {
    expect(resolveLedgerBiller({ biller: "", provider: "google" })).toBe("google");
  });

  it("returns 'unknown' when both are absent", () => {
    expect(resolveLedgerBiller({ biller: null, provider: null })).toBe("unknown");
  });

  it("accepts segment-shaped objects (Pick<AdapterExecutionResult>)", () => {
    const segment: Pick<AdapterExecutionResult, "biller" | "provider"> = {
      biller: "segment-biller",
      provider: "segment-provider",
    };
    expect(resolveLedgerBiller(segment)).toBe("segment-biller");
  });

  it("resolves segment biller with fallback to result provider", () => {
    const merged: Pick<AdapterExecutionResult, "biller" | "provider"> = {
      biller: null,
      provider: "anthropic",
    };
    expect(resolveLedgerBiller(merged)).toBe("anthropic");
  });
});

describe("normalizeLedgerBillingType", () => {
  it("normalizes 'api' to 'metered_api'", () => {
    expect(normalizeLedgerBillingType("api")).toBe("metered_api");
  });

  it("normalizes 'metered_api' to 'metered_api'", () => {
    expect(normalizeLedgerBillingType("metered_api")).toBe("metered_api");
  });

  it("normalizes 'subscription' to 'subscription_included'", () => {
    expect(normalizeLedgerBillingType("subscription")).toBe("subscription_included");
  });

  it("normalizes 'credits' to 'credits'", () => {
    expect(normalizeLedgerBillingType("credits")).toBe("credits");
  });

  it("returns 'unknown' for null/undefined", () => {
    expect(normalizeLedgerBillingType(null)).toBe("unknown");
    expect(normalizeLedgerBillingType(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for unrecognized string", () => {
    expect(normalizeLedgerBillingType("something_else")).toBe("unknown");
  });
});

describe("normalizeBilledCostCents", () => {
  it("converts USD to cents", () => {
    expect(normalizeBilledCostCents(0.42, "metered_api")).toBe(42);
  });

  it("rounds fractional cents", () => {
    expect(normalizeBilledCostCents(0.005, "metered_api")).toBe(1);
    expect(normalizeBilledCostCents(0.004, "metered_api")).toBe(0);
  });

  it("returns 0 for subscription_included billing", () => {
    expect(normalizeBilledCostCents(1.5, "subscription_included")).toBe(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(normalizeBilledCostCents(null, "metered_api")).toBe(0);
    expect(normalizeBilledCostCents(undefined, "metered_api")).toBe(0);
  });

  it("clamps negative values to 0", () => {
    expect(normalizeBilledCostCents(-1, "metered_api")).toBe(0);
  });
});

describe("normalizeUsageTotals", () => {
  it("normalizes valid usage", () => {
    expect(normalizeUsageTotals({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 }))
      .toEqual({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 });
  });

  it("returns null for null/undefined", () => {
    expect(normalizeUsageTotals(null)).toBeNull();
    expect(normalizeUsageTotals(undefined)).toBeNull();
  });

  it("floors fractional token counts", () => {
    expect(normalizeUsageTotals({ inputTokens: 10.7, outputTokens: 5.3 }))
      .toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
  });

  it("clamps negative values to 0", () => {
    expect(normalizeUsageTotals({ inputTokens: -5, outputTokens: 10 }))
      .toEqual({ inputTokens: 0, outputTokens: 10, cachedInputTokens: 0 });
  });
});

describe("ExecutionSegment contract", () => {
  it("validates typical two-segment routing result shape", () => {
    const segments: ExecutionSegment[] = [
      {
        phase: "cheap_preflight",
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
        billingType: "metered_api",
        usage: { inputTokens: 1500, outputTokens: 400 },
        costUsd: 0.0005,
        summary: "Oriented to task, posted progress comment.",
      },
      {
        phase: "primary",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        billingType: "metered_api",
        usage: { inputTokens: 50000, outputTokens: 15000, cachedInputTokens: 10000 },
        costUsd: 0.05,
      },
    ];

    expect(segments).toHaveLength(2);
    expect(segments[0]!.phase).toBe("cheap_preflight");
    expect(segments[1]!.phase).toBe("primary");

    // Biller resolution per segment uses merge fallback
    for (const seg of segments) {
      const biller = resolveLedgerBiller({
        biller: seg.biller ?? null,
        provider: seg.provider ?? null,
      });
      expect(biller).toBe("anthropic");
    }

    // Billing type normalization per segment
    for (const seg of segments) {
      expect(normalizeLedgerBillingType(seg.billingType)).toBe("metered_api");
    }

    // Cost conversion per segment
    expect(normalizeBilledCostCents(segments[0]!.costUsd, "metered_api")).toBe(0);
    expect(normalizeBilledCostCents(segments[1]!.costUsd, "metered_api")).toBe(5);
  });
});