import { describe, expect, it } from "vitest";
import { formatCents, visibleRunCostUsd } from "./utils";

describe("formatCents", () => {
  it("formats a positive cents value as USD with two decimal places", () => {
    expect(formatCents(12345)).toBe("$123.45");
  });

  it("formats zero as $0.00", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("renders the default em-dash for null", () => {
    expect(formatCents(null)).toBe("—");
  });

  it("renders the default em-dash for undefined", () => {
    expect(formatCents(undefined)).toBe("—");
  });

  it("honors a custom nullDisplay for null", () => {
    expect(formatCents(null, { nullDisplay: "unpriced" })).toBe("unpriced");
  });

  it("honors a custom nullDisplay for undefined", () => {
    expect(formatCents(undefined, { nullDisplay: "n/a" })).toBe("n/a");
  });

  it("ignores nullDisplay when a real value is provided (including zero)", () => {
    expect(formatCents(0, { nullDisplay: "n/a" })).toBe("$0.00");
    expect(formatCents(50, { nullDisplay: "n/a" })).toBe("$0.50");
  });
});

describe("visibleRunCostUsd", () => {
  it("returns null when neither usage nor result carries a cost field", () => {
    expect(visibleRunCostUsd({}, {})).toBeNull();
    expect(visibleRunCostUsd(null, null)).toBeNull();
  });

  it("preserves a genuine zero cost (does not collapse to null)", () => {
    expect(visibleRunCostUsd({ costUsd: 0 }, null)).toBe(0);
  });

  it("returns the usage cost when present", () => {
    expect(visibleRunCostUsd({ costUsd: 1.25 }, null)).toBe(1.25);
  });

  it("falls back to the result cost when usage is missing one", () => {
    expect(visibleRunCostUsd({}, { total_cost_usd: 0.5 })).toBe(0.5);
  });

  it("prefers usage cost over result cost when both are present, including zero", () => {
    expect(visibleRunCostUsd({ costUsd: 0 }, { costUsd: 1.0 })).toBe(0);
  });

  it("returns 0 for subscription_included billing type regardless of cost field", () => {
    expect(visibleRunCostUsd({ billingType: "subscription_included", costUsd: 5 }, null)).toBe(0);
  });
});
