import { describe, expect, it } from "vitest";
import { isNonEmptyString, readNonEmptyString, readNonEmptyTrimmedString } from "./strings.js";

describe("isNonEmptyString", () => {
  it("accepts strings with non-whitespace content", () => {
    expect(isNonEmptyString("a")).toBe(true);
    expect(isNonEmptyString("  a  ")).toBe(true);
  });

  it("rejects blank strings and non-strings", () => {
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isNonEmptyString("\n\t")).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(0)).toBe(false);
    expect(isNonEmptyString(["a"])).toBe(false);
  });
});

describe("readNonEmptyString", () => {
  it("returns the ORIGINAL string untrimmed", () => {
    expect(readNonEmptyString("  session-id \n")).toBe("  session-id \n");
    expect(readNonEmptyString("plain")).toBe("plain");
  });

  it("returns null for blank strings and non-strings", () => {
    expect(readNonEmptyString("")).toBeNull();
    expect(readNonEmptyString("   ")).toBeNull();
    expect(readNonEmptyString(null)).toBeNull();
    expect(readNonEmptyString(42)).toBeNull();
  });
});

describe("readNonEmptyTrimmedString", () => {
  it("returns the TRIMMED string", () => {
    expect(readNonEmptyTrimmedString("  padded  ")).toBe("padded");
    expect(readNonEmptyTrimmedString("plain")).toBe("plain");
  });

  it("returns null for blank strings and non-strings", () => {
    expect(readNonEmptyTrimmedString("")).toBeNull();
    expect(readNonEmptyTrimmedString(" \t ")).toBeNull();
    expect(readNonEmptyTrimmedString(undefined)).toBeNull();
    expect(readNonEmptyTrimmedString({})).toBeNull();
  });
});
