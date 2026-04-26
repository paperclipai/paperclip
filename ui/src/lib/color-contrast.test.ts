import { describe, expect, it } from "vitest";
import { hexToRgb, pickTextColorForSolidBg } from "./color-contrast.js";

// ============================================================================
// hexToRgb
// ============================================================================

describe("hexToRgb", () => {
  it("parses a 6-digit hex color with # prefix", () => {
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("parses a 6-digit hex color without # prefix", () => {
    expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("expands 3-digit hex shorthand", () => {
    expect(hexToRgb("#f00")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("#0f0")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("is case-insensitive", () => {
    expect(hexToRgb("#FF0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("returns null for invalid hex string", () => {
    expect(hexToRgb("not-a-color")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(hexToRgb("")).toBeNull();
  });

  it("trims whitespace before parsing", () => {
    expect(hexToRgb("  #ff0000  ")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("parses black correctly", () => {
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("parses white correctly", () => {
    expect(hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
  });
});

// ============================================================================
// pickTextColorForSolidBg
// ============================================================================

describe("pickTextColorForSolidBg", () => {
  it("returns light text for a very dark background (black)", () => {
    // Black background → should use light text
    const result = pickTextColorForSolidBg("#000000");
    expect(result).toBe("#f8fafc");
  });

  it("returns dark text for a very light background (white)", () => {
    // White background → should use dark text
    const result = pickTextColorForSolidBg("#ffffff");
    expect(result).toBe("#111827");
  });

  it("returns light text for invalid hex color (fallback)", () => {
    expect(pickTextColorForSolidBg("not-a-color")).toBe("#f8fafc");
  });

  it("returns a string for any valid color", () => {
    const result = pickTextColorForSolidBg("#336699");
    expect(typeof result).toBe("string");
    expect(result.startsWith("#")).toBe(true);
  });
});
