import { describe, expect, it } from "vitest";
import { resourceStatus, stockHash } from "./managed-resource-drift.js";

describe("managed resource drift", () => {
  it("uses deterministic object-key ordering for stock hashes", () => {
    expect(stockHash({ a: 1, b: { c: 2 } })).toBe(
      stockHash({ b: { c: 2 }, a: 1 }),
    );
  });

  it.each([
    {
      expected: "missing",
      resourceId: null,
      currentHash: null,
      bindingStockHash: null,
      latestStockHash: "latest",
    },
    {
      expected: "stock_current",
      resourceId: "resource-1",
      currentHash: "latest",
      bindingStockHash: "previous",
      latestStockHash: "latest",
    },
    {
      expected: "stock_update_available",
      resourceId: "resource-1",
      currentHash: "previous",
      bindingStockHash: "previous",
      latestStockHash: "latest",
    },
    {
      expected: "operator_modified",
      resourceId: "resource-1",
      currentHash: "operator",
      bindingStockHash: "previous",
      latestStockHash: "latest",
    },
  ] as const)("classifies $expected", ({ expected, ...input }) => {
    expect(resourceStatus(input)).toBe(expected);
  });
});
