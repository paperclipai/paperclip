import { describe, expect, it } from "vitest";
import { budgetDollarsFromCents, MAX_BUDGET_CENTS, parseBudgetDollarsToCents } from "./utils";

describe("parseBudgetDollarsToCents", () => {
  it("converts whole dollars to cents", () => {
    expect(parseBudgetDollarsToCents("1200")).toBe(120_000);
  });

  it("keeps a fractional dollar amount as cents", () => {
    expect(parseBudgetDollarsToCents("9.99")).toBe(999);
  });

  it("rounds a sub-cent amount to the nearest cent", () => {
    expect(parseBudgetDollarsToCents("1.506")).toBe(151);
  });

  it("treats a blank value as no budget change", () => {
    expect(parseBudgetDollarsToCents("   ")).toBeUndefined();
  });

  it("rejects a negative amount", () => {
    expect(parseBudgetDollarsToCents("-5")).toBeUndefined();
  });

  it("rejects a value that is not a number", () => {
    expect(parseBudgetDollarsToCents("ten")).toBeUndefined();
  });

  it("accepts zero as an explicit no-limit budget", () => {
    expect(parseBudgetDollarsToCents("0")).toBe(0);
  });

  it("rejects partial scientific notation instead of reading it as blank", () => {
    expect(parseBudgetDollarsToCents("1e")).toBeUndefined();
  });

  it("accepts the largest amount the budget column holds", () => {
    expect(parseBudgetDollarsToCents(String(MAX_BUDGET_CENTS / 100))).toBe(MAX_BUDGET_CENTS);
  });

  it("rejects an amount the budget column cannot hold", () => {
    expect(parseBudgetDollarsToCents("25000000")).toBeUndefined();
  });
});

describe("budgetDollarsFromCents", () => {
  it("renders cents as a plain dollar amount", () => {
    expect(budgetDollarsFromCents(120_000)).toBe("1200");
  });

  it("keeps the fractional part when the amount is not whole dollars", () => {
    expect(budgetDollarsFromCents(150)).toBe("1.5");
  });

  it("renders zero as a blank input", () => {
    expect(budgetDollarsFromCents(0)).toBe("");
  });
});
