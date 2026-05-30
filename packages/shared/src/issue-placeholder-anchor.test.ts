import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_ANCHOR_SENTINEL,
  hasPlaceholderAnchorMarker,
} from "./issue-placeholder-anchor.js";

describe("hasPlaceholderAnchorMarker", () => {
  it("matches the canonical sentinel as the whole description", () => {
    expect(hasPlaceholderAnchorMarker(PLACEHOLDER_ANCHOR_SENTINEL)).toBe(true);
  });

  it("matches the sentinel embedded in a larger description", () => {
    const description = [
      "# Trading-day umbrella placeholder",
      "",
      PLACEHOLDER_ANCHOR_SENTINEL,
      "",
      "Owned by the trading-day umbrella. Auto-resolved at EOD.",
    ].join("\n");
    expect(hasPlaceholderAnchorMarker(description)).toBe(true);
  });

  it("accepts an ASCII hyphen instead of the em dash", () => {
    expect(
      hasPlaceholderAnchorMarker("Placeholder anchor - DO NOT manually start."),
    ).toBe(true);
  });

  it("is case insensitive on the phrase", () => {
    expect(
      hasPlaceholderAnchorMarker("placeholder ANCHOR — do not manually START."),
    ).toBe(true);
  });

  it("returns false for null, undefined, and empty strings", () => {
    expect(hasPlaceholderAnchorMarker(null)).toBe(false);
    expect(hasPlaceholderAnchorMarker(undefined)).toBe(false);
    expect(hasPlaceholderAnchorMarker("")).toBe(false);
  });

  it("does not match descriptions that lack the sentinel", () => {
    expect(hasPlaceholderAnchorMarker("just a regular issue")).toBe(false);
    expect(hasPlaceholderAnchorMarker("placeholder anchor only")).toBe(false);
    expect(
      hasPlaceholderAnchorMarker("DO NOT manually start without a placeholder"),
    ).toBe(false);
  });
});
