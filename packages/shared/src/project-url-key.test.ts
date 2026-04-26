import { describe, expect, it } from "vitest";
import { normalizeProjectUrlKey, hasNonAsciiContent, deriveProjectUrlKey } from "./project-url-key.js";

// ============================================================================
// normalizeProjectUrlKey
// ============================================================================

describe("normalizeProjectUrlKey", () => {
  it("lowercases the input", () => {
    expect(normalizeProjectUrlKey("MyProject")).toBe("myproject");
  });

  it("replaces spaces with hyphens", () => {
    expect(normalizeProjectUrlKey("my project")).toBe("my-project");
  });

  it("collapses multiple non-alphanumeric chars into one hyphen", () => {
    expect(normalizeProjectUrlKey("my  --  project")).toBe("my-project");
  });

  it("strips leading and trailing hyphens", () => {
    expect(normalizeProjectUrlKey("--project--")).toBe("project");
  });

  it("returns null for null input", () => {
    expect(normalizeProjectUrlKey(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeProjectUrlKey(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeProjectUrlKey("")).toBeNull();
  });

  it("preserves digits", () => {
    expect(normalizeProjectUrlKey("project-2024")).toBe("project-2024");
  });
});

// ============================================================================
// hasNonAsciiContent
// ============================================================================

describe("hasNonAsciiContent", () => {
  it("returns false for ASCII-only string", () => {
    expect(hasNonAsciiContent("hello")).toBe(false);
  });

  it("returns true for string with non-ASCII characters", () => {
    expect(hasNonAsciiContent("café")).toBe(true);
  });

  it("returns true for CJK characters", () => {
    expect(hasNonAsciiContent("项目")).toBe(true);
  });

  it("returns false for null", () => {
    expect(hasNonAsciiContent(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasNonAsciiContent(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasNonAsciiContent("")).toBe(false);
  });
});

// ============================================================================
// deriveProjectUrlKey
// ============================================================================

describe("deriveProjectUrlKey", () => {
  it("returns normalized ASCII name directly", () => {
    expect(deriveProjectUrlKey("My Project")).toBe("my-project");
  });

  it("falls back to fallback when name is null", () => {
    expect(deriveProjectUrlKey(null, "Fallback Project")).toBe("fallback-project");
  });

  it("returns 'project' when both name and fallback are null", () => {
    expect(deriveProjectUrlKey(null, null)).toBe("project");
  });

  it("returns 'project' when name is undefined", () => {
    expect(deriveProjectUrlKey(undefined)).toBe("project");
  });

  it("appends short UUID suffix for non-ASCII name with valid UUID fallback", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = deriveProjectUrlKey("café", uuid);
    // Should be "caf-{first-8-hex-chars-of-uuid}"
    expect(result).toMatch(/^caf-[0-9a-f]{8}$/);
  });

  it("returns short UUID when name is purely non-ASCII and fallback is valid UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = deriveProjectUrlKey("项目", uuid);
    // purely non-ASCII collapses to empty after normalization, so returns short UUID
    expect(result).toBe("550e8400");
  });
});
