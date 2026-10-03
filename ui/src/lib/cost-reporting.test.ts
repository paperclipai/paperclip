import { describe, expect, it, vi } from "vitest";
import { formatCents, visibleRunCostUsd } from "./utils";
import { computeRange } from "../hooks/useDateRange";

describe("cost presentation", () => {
  it("shows the adjusted charge and respects an explicit zero", () => {
    expect(visibleRunCostUsd({ costUsd: 3.1, cacheAdjustedCostUsd: 1.5 })).toBe(1.5);
    expect(visibleRunCostUsd({ cacheAdjustedCostUsd: 0 }, { costUsd: 5 })).toBe(0);
    expect(visibleRunCostUsd({ cacheAdjustedCostUsd: 0.004 })).toBe(0.004);
    expect(visibleRunCostUsd({ costUsd: -1 }, { costUsd: 2 })).toBe(2);
    expect(visibleRunCostUsd({ billingType: "subscription_included", costUsd: 50 })).toBe(0);
  });

  it("formats finance amounts in their recorded currency", () => {
    expect(formatCents(123, "USD")).toBe("$1.23");
    expect(formatCents(123, "EUR")).toBe("€1.23");
  });

  it("starts month-to-date at the UTC boundary even before local midnight", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-01T00:30:00.000Z"));
      expect(computeRange("mtd")).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-01T00:30:00.000Z" });
    } finally { vi.useRealTimers(); }
  });
});
