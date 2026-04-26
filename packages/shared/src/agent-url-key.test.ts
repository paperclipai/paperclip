import { describe, expect, it } from "vitest";
import { isUuidLike, normalizeAgentUrlKey, deriveAgentUrlKey } from "./agent-url-key.js";

// ============================================================================
// isUuidLike
// ============================================================================

describe("isUuidLike", () => {
  it("returns true for a valid UUID v4", () => {
    expect(isUuidLike("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("returns true for UUID with uppercase letters", () => {
    expect(isUuidLike("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("returns false for a plain string", () => {
    expect(isUuidLike("my-agent")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isUuidLike(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isUuidLike(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isUuidLike("")).toBe(false);
  });

  it("trims whitespace before testing", () => {
    expect(isUuidLike("  550e8400-e29b-41d4-a716-446655440000  ")).toBe(true);
  });
});

// ============================================================================
// normalizeAgentUrlKey
// ============================================================================

describe("normalizeAgentUrlKey", () => {
  it("lowercases the input", () => {
    expect(normalizeAgentUrlKey("MyAgent")).toBe("myagent");
  });

  it("replaces spaces with hyphens", () => {
    expect(normalizeAgentUrlKey("my agent")).toBe("my-agent");
  });

  it("replaces special characters with hyphens", () => {
    expect(normalizeAgentUrlKey("agent@name!")).toBe("agent-name");
  });

  it("collapses multiple delimiters into one hyphen", () => {
    expect(normalizeAgentUrlKey("my  --  agent")).toBe("my-agent");
  });

  it("strips leading and trailing hyphens", () => {
    expect(normalizeAgentUrlKey("--agent--")).toBe("agent");
  });

  it("returns null for null input", () => {
    expect(normalizeAgentUrlKey(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeAgentUrlKey(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeAgentUrlKey("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normalizeAgentUrlKey("   ")).toBeNull();
  });

  it("preserves digits", () => {
    expect(normalizeAgentUrlKey("agent-2")).toBe("agent-2");
  });
});

// ============================================================================
// deriveAgentUrlKey
// ============================================================================

describe("deriveAgentUrlKey", () => {
  it("returns normalized name when name is valid", () => {
    expect(deriveAgentUrlKey("My Agent")).toBe("my-agent");
  });

  it("falls back to fallback when name is null", () => {
    expect(deriveAgentUrlKey(null, "Fallback Agent")).toBe("fallback-agent");
  });

  it("falls back to fallback when name normalizes to empty", () => {
    expect(deriveAgentUrlKey("---", "Fallback")).toBe("fallback");
  });

  it("returns 'agent' when both name and fallback are null", () => {
    expect(deriveAgentUrlKey(null, null)).toBe("agent");
  });

  it("returns 'agent' when both name and fallback are undefined", () => {
    expect(deriveAgentUrlKey(undefined)).toBe("agent");
  });
});
