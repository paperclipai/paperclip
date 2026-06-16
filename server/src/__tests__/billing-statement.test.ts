import { describe, expect, it } from "vitest";
import { applyMarkup, summarizeBillingStatement } from "../services/billing.ts";

describe("applyMarkup", () => {
  it("returns raw cost at 0 bps (at-cost)", () => {
    expect(applyMarkup(1234, 0)).toBe(1234);
  });
  it("applies a 20% markup (2000 bps)", () => {
    expect(applyMarkup(1000, 2000)).toBe(1200);
  });
  it("rounds to the nearest cent", () => {
    expect(applyMarkup(101, 2000)).toBe(121); // 101 * 1.2 = 121.2 → 121
  });
  it("treats negative/garbage markup as 0", () => {
    expect(applyMarkup(500, -5)).toBe(500);
    expect(applyMarkup(500, Number.NaN)).toBe(500);
  });
});

describe("summarizeBillingStatement", () => {
  const period = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z") };

  it("aggregates by provider+model, totals raw, and applies markup", () => {
    const stmt = summarizeBillingStatement({
      companyId: "co-1",
      periodStart: period.from,
      periodEnd: period.to,
      currency: "usd",
      markupBps: 2000,
      rows: [
        { provider: "anthropic", model: "opus", inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, rawCostCents: 600 },
        { provider: "anthropic", model: "opus", inputTokens: 200, cachedInputTokens: 10, outputTokens: 80, rawCostCents: 400 },
        { provider: "anthropic", model: "haiku", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 300, rawCostCents: 100 },
      ],
    });

    expect(stmt.rawCostCents).toBe(1100);
    expect(stmt.billableCostCents).toBe(1320); // 1100 * 1.2
    expect(stmt.totalInputTokens).toBe(1300);
    expect(stmt.totalOutputTokens).toBe(430);
    // Two line items (opus merged, haiku), sorted by raw cost desc.
    expect(stmt.lineItems).toHaveLength(2);
    expect(stmt.lineItems[0]).toMatchObject({ model: "opus", rawCostCents: 1000, billableCostCents: 1200, inputTokens: 300 });
    expect(stmt.lineItems[1]).toMatchObject({ model: "haiku", rawCostCents: 100, billableCostCents: 120 });
  });

  it("bills the total off summed raw (no per-line rounding drift)", () => {
    // Three lines that each round down individually but should sum cleanly off the raw total.
    const stmt = summarizeBillingStatement({
      companyId: "co-1",
      periodStart: period.from,
      periodEnd: period.to,
      currency: "usd",
      markupBps: 2000,
      rows: [
        { provider: "p", model: "a", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, rawCostCents: 1 },
        { provider: "p", model: "b", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, rawCostCents: 1 },
        { provider: "p", model: "c", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, rawCostCents: 1 },
      ],
    });
    // raw 3 → billable round(3 * 1.2) = round(3.6) = 4; per-line each round(1.2)=1 would sum to 3.
    expect(stmt.rawCostCents).toBe(3);
    expect(stmt.billableCostCents).toBe(4);
  });

  it("handles an empty period", () => {
    const stmt = summarizeBillingStatement({
      companyId: "co-1",
      periodStart: period.from,
      periodEnd: period.to,
      currency: "usd",
      markupBps: 2000,
      rows: [],
    });
    expect(stmt.rawCostCents).toBe(0);
    expect(stmt.billableCostCents).toBe(0);
    expect(stmt.lineItems).toEqual([]);
  });
});
