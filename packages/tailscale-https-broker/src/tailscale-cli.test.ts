import { describe, expect, it } from "vitest";
import { isSupportedTailscaleVersion, parseTailscaleVersion } from "./tailscale-cli.js";

describe("parseTailscaleVersion", () => {
  it("parses the numeric major.minor prefix of CLI output", () => {
    expect(parseTailscaleVersion("1.102.2\n  tailscale commit: abc\n")).toEqual({ major: 1, minor: 102 });
    expect(parseTailscaleVersion("  1.80.3")).toEqual({ major: 1, minor: 80 });
  });

  it("returns null for malformed output", () => {
    expect(parseTailscaleVersion("")).toBeNull();
    expect(parseTailscaleVersion("garbage")).toBeNull();
    expect(parseTailscaleVersion("v1.80.1")).toBeNull();
    expect(parseTailscaleVersion("1")).toBeNull();
    expect(parseTailscaleVersion("tailscale 1.80")).toBeNull();
  });
});

describe("isSupportedTailscaleVersion", () => {
  it("accepts the minimum version and anything newer", () => {
    expect(isSupportedTailscaleVersion("1.80.0")).toBe(true);
    expect(isSupportedTailscaleVersion("1.84.1")).toBe(true);
    // Numeric, not lexicographic: "1.102" < "1.80" as strings.
    expect(isSupportedTailscaleVersion("1.102.2\n  tailscale commit: abc\n")).toBe(true);
    expect(isSupportedTailscaleVersion("2.0.0")).toBe(true);
  });

  it("rejects versions below the minimum", () => {
    expect(isSupportedTailscaleVersion("1.78")).toBe(false);
    expect(isSupportedTailscaleVersion("1.79.9")).toBe(false);
    expect(isSupportedTailscaleVersion("0.99.0")).toBe(false);
  });

  it("rejects malformed version output", () => {
    expect(isSupportedTailscaleVersion("")).toBe(false);
    expect(isSupportedTailscaleVersion("garbage")).toBe(false);
    expect(isSupportedTailscaleVersion("v1.102.2")).toBe(false);
  });
});
