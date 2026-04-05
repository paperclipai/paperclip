import { describe, expect, it } from "vitest";
import { isUuidLike, normalizeAgentUrlKey, deriveAgentUrlKey } from "./agent-url-key.js";

describe("isUuidLike", () => {
  it("returns true for a valid v4 UUID", () => {
    expect(isUuidLike("7f688d51-cf70-495b-806e-e672e7175da6")).toBe(true);
  });

  it("returns true for uppercase UUID", () => {
    expect(isUuidLike("7F688D51-CF70-495B-806E-E672E7175DA6")).toBe(true);
  });

  it("returns false for non-UUID strings", () => {
    expect(isUuidLike("not-a-uuid")).toBe(false);
    expect(isUuidLike("12345")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isUuidLike(null)).toBe(false);
    expect(isUuidLike(undefined)).toBe(false);
  });

  it("trims whitespace before checking", () => {
    expect(isUuidLike("  7f688d51-cf70-495b-806e-e672e7175da6  ")).toBe(true);
  });
});

describe("normalizeAgentUrlKey", () => {
  it("lowercases and replaces non-alphanumeric chars with hyphens", () => {
    expect(normalizeAgentUrlKey("Dev Agent — Platform")).toBe("dev-agent-platform");
  });

  it("trims leading/trailing hyphens", () => {
    expect(normalizeAgentUrlKey("--hello--")).toBe("hello");
  });

  it("returns null for empty or whitespace-only strings", () => {
    expect(normalizeAgentUrlKey("")).toBe(null);
    expect(normalizeAgentUrlKey("   ")).toBe(null);
  });

  it("returns null for null/undefined", () => {
    expect(normalizeAgentUrlKey(null)).toBe(null);
    expect(normalizeAgentUrlKey(undefined)).toBe(null);
  });

  it("collapses multiple delimiters into a single hyphen", () => {
    expect(normalizeAgentUrlKey("a   b---c")).toBe("a-b-c");
  });
});

describe("deriveAgentUrlKey", () => {
  it("derives from name when valid", () => {
    expect(deriveAgentUrlKey("CTO")).toBe("cto");
  });

  it("falls back to fallback when name produces null", () => {
    expect(deriveAgentUrlKey(null, "My Fallback")).toBe("my-fallback");
  });

  it("returns 'agent' when both name and fallback are null", () => {
    expect(deriveAgentUrlKey(null, null)).toBe("agent");
  });

  it("returns 'agent' when both name and fallback are empty", () => {
    expect(deriveAgentUrlKey("", "")).toBe("agent");
  });
});
