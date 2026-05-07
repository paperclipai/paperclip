import { describe, expect, it } from "vitest";
import { coerceListQueryParam } from "../routes/issues.ts";

describe("coerceListQueryParam", () => {
  it("returns undefined for missing values", () => {
    expect(coerceListQueryParam(undefined)).toBeUndefined();
    expect(coerceListQueryParam(null)).toBeUndefined();
  });

  it("passes through a single comma-separated string", () => {
    expect(coerceListQueryParam("critical,high")).toBe("critical,high");
  });

  it("trims whitespace around the value", () => {
    expect(coerceListQueryParam("  high  ")).toBe("high");
  });

  it("treats the empty / whitespace-only string as undefined", () => {
    expect(coerceListQueryParam("")).toBeUndefined();
    expect(coerceListQueryParam("   ")).toBeUndefined();
  });

  it("flattens the repeated-key array form into a comma-separated string", () => {
    expect(coerceListQueryParam(["critical", "high"])).toBe("critical,high");
  });

  it("flattens mixed array entries that themselves contain commas", () => {
    expect(coerceListQueryParam(["critical,high", "medium"])).toBe("critical,high,medium");
  });

  it("drops empty array entries", () => {
    expect(coerceListQueryParam(["critical", "", "  ", "high"])).toBe("critical,high");
    expect(coerceListQueryParam([])).toBeUndefined();
    expect(coerceListQueryParam(["", "   "])).toBeUndefined();
  });

  it("rejects non-string array entries (qs nested form) by returning undefined", () => {
    // qs's nested-object form would return an object here; failing closed
    // is preferable to silently widening the result set.
    expect(coerceListQueryParam([{ foo: "bar" } as unknown as string])).toBeUndefined();
  });

  it("rejects non-string, non-array values by returning undefined", () => {
    expect(coerceListQueryParam({ foo: "bar" })).toBeUndefined();
    expect(coerceListQueryParam(42 as unknown)).toBeUndefined();
  });
});
