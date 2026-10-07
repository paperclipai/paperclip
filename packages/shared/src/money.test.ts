import { describe, expect, it } from "vitest";
import { addCents, centsToUnits, centsToUsd, compareCents, formatUsdExact, MAX_MONEY_UNITS, normalizeCents, subtractCents, unitsToCents, usdToCents } from "./money.js";

describe("fixed-point money", () => {
  it.each([
    ["0.00000005", "0.0000001"], ["-0.00000005", "-0.0000001"],
    ["0.000000049", "0.0000000"], ["1e-7", "0.0000001"],
    ["12345678901234567.1234567", "12345678901234567.1234567"],
  ])("normalizes %s exactly", (input, expected) => expect(normalizeCents(input)).toBe(expected));
  it("does exact arithmetic beyond floating-point precision", () => {
    expect(addCents("12345678901234567.1234567", "0.0000001")).toBe("12345678901234567.1234568");
    expect(subtractCents("9007199254740992.0000001", "9007199254740992")).toBe("0.0000001");
    expect(compareCents("9007199254740992.0000001", "9007199254740992")).toBe(1);
    expect(addCents(0.1, 0.2)).toBe("0.3000000");
  });
  it("converts USD without intermediate multiplication or double rounding", () => {
    expect(usdToCents("0.000000001")).toBe("0.0000001");
    expect(usdToCents("0.00000000049")).toBe("0.0000000");
    expect(usdToCents("0.0123456789")).toBe("1.2345679");
    expect(formatUsdExact("4.5")).toBe("$0.05");
  });
  it("round-trips the full database range", () => expect(centsToUnits(unitsToCents(MAX_MONEY_UNITS))).toBe(MAX_MONEY_UNITS));
  it.each(["0.0000001", "9007199254740992.0000001", "-0.0000001", unitsToCents(MAX_MONEY_UNITS)])("preserves an editable USD value for %s cents", cents => {
    expect(usdToCents(centsToUsd(cents))).toBe(cents);
  });
  it.each(["NaN", "Infinity", "", " 1", "1.2.3", "1e101", "100000000000000000", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid/out-of-range %s", input => {
    expect(() => centsToUnits(input)).toThrow();
  });
});
