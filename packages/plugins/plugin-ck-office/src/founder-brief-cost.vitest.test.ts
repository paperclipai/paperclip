import { describe, expect, it } from "vitest";
import { renderFounderBriefCostLines } from "./founder-brief.js";

describe("renderFounderBriefCostLines", () => {
  it("separates priced metered spend from subscription and unpriced coverage", () => {
    expect(
      renderFounderBriefCostLines({
        costCents: 37.110118,
        pricedCostEventCount: 59,
        nonPricedCostEventCount: 994,
      }),
    ).toEqual([
      "  - Recorded metered API spend: $0.37 across 59 priced event(s).",
      "  - Coverage note: 994 subscription-included or unpriced event(s) are excluded from spend.",
    ]);
  });

  it("omits an empty coverage caveat", () => {
    expect(
      renderFounderBriefCostLines({
        costCents: 0,
        pricedCostEventCount: 0,
        nonPricedCostEventCount: 0,
      }),
    ).toEqual(["  - Recorded metered API spend: $0.00 across 0 priced event(s)."]);
  });
});
