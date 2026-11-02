import { describe, expect, it } from "vitest";
import { assertCanonicalPort, parseCanonicalIntegerString } from "./integers.js";

describe("assertCanonicalPort", () => {
  it("accepts in-range integers", () => {
    expect(assertCanonicalPort(1)).toBe(1);
    expect(assertCanonicalPort(42010)).toBe(42010);
    expect(assertCanonicalPort(65535)).toBe(65535);
  });

  it("rejects non-numbers, non-integers, and out-of-range", () => {
    expect(() => assertCanonicalPort("42010")).toThrow();
    expect(() => assertCanonicalPort(42010.5)).toThrow();
    expect(() => assertCanonicalPort(0)).toThrow();
    expect(() => assertCanonicalPort(-1)).toThrow();
    expect(() => assertCanonicalPort(65536)).toThrow();
    expect(() => assertCanonicalPort(Number.NaN)).toThrow();
    expect(() => assertCanonicalPort(Infinity)).toThrow();
    expect(() => assertCanonicalPort(null)).toThrow();
  });
});

describe("parseCanonicalIntegerString", () => {
  it("accepts canonical decimal strings", () => {
    expect(parseCanonicalIntegerString("0")).toBe(0);
    expect(parseCanonicalIntegerString("42010")).toBe(42010);
  });

  it("rejects signs, whitespace, leading zeros, decimals, and exponents", () => {
    expect(() => parseCanonicalIntegerString("+42010")).toThrow();
    expect(() => parseCanonicalIntegerString("-1")).toThrow();
    expect(() => parseCanonicalIntegerString(" 42010")).toThrow();
    expect(() => parseCanonicalIntegerString("42010 ")).toThrow();
    expect(() => parseCanonicalIntegerString("007")).toThrow();
    expect(() => parseCanonicalIntegerString("00")).toThrow();
    expect(() => parseCanonicalIntegerString("4.2")).toThrow();
    expect(() => parseCanonicalIntegerString("4e2")).toThrow();
  });

  it("rejects Unicode digits and non-string input", () => {
    // Arabic-Indic digits for 42010.
    expect(() => parseCanonicalIntegerString("٤٢٠١٠")).toThrow();
    // Fullwidth digits.
    expect(() => parseCanonicalIntegerString("４２０１０")).toThrow();
    expect(() => parseCanonicalIntegerString(42010 as unknown as string)).toThrow();
  });

  it("rejects integer overflow beyond safe range", () => {
    expect(() => parseCanonicalIntegerString("99999999999999999999")).toThrow();
  });
});
