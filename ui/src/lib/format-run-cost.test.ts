import { describe, expect, it } from "vitest";
import { formatRunCostDisplay } from "./utils";

describe("formatRunCostDisplay", () => {
  it("formats a metered cost to 4 decimals", () => {
    expect(
      formatRunCostDisplay({
        costUsd: 0.0023,
        hasTokenUsage: true,
        usage: { billingType: "metered_api" },
      }),
    ).toBe("$0.0023");
  });

  it("returns Included for subscription-billed runs", () => {
    expect(
      formatRunCostDisplay({
        costUsd: 0,
        hasTokenUsage: true,
        usage: { billingType: "subscription_included" },
      }),
    ).toBe("Included");
  });

  it("returns N/A (local) when tokens are reported but cost is unknown (acpx-local)", () => {
    expect(
      formatRunCostDisplay({
        costUsd: 0,
        hasTokenUsage: true,
        usage: { billingType: "unknown", provider: "acpx" },
      }),
    ).toBe("N/A (local)");
  });

  it("falls back to '-' when there is no usage and no cost", () => {
    expect(
      formatRunCostDisplay({
        costUsd: 0,
        hasTokenUsage: false,
        usage: null,
      }),
    ).toBe("-");
  });

  it("prefers a positive cost even if billingType is unknown", () => {
    expect(
      formatRunCostDisplay({
        costUsd: 0.5,
        hasTokenUsage: true,
        usage: { billingType: "unknown" },
      }),
    ).toBe("$0.5000");
  });
});
