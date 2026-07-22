import { describe, expect, it } from "vitest";
import { formatProjectBudget } from "./utils";

describe("formatProjectBudget", () => {
  it("renders a /mo suffix for monthly budgets", () => {
    expect(formatProjectBudget({ amountCents: 120_000, windowKind: "calendar_month_utc" })).toBe("$1,200.00/mo");
  });

  it("renders the bare amount for lifetime budgets", () => {
    expect(formatProjectBudget({ amountCents: 50_000, windowKind: "lifetime" })).toBe("$500.00");
  });

  it("formats sub-dollar amounts with cents", () => {
    expect(formatProjectBudget({ amountCents: 150, windowKind: "lifetime" })).toBe("$1.50");
  });
});
