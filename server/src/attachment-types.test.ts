// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  parseAllowedTypes,
  matchesContentType,
  normalizeContentType,
  isInlineAttachmentContentType,
  DEFAULT_ALLOWED_TYPES,
  INLINE_ATTACHMENT_TYPES,
} from "./attachment-types.js";

// ============================================================================
// parseAllowedTypes
// ============================================================================

describe("parseAllowedTypes", () => {
  it("returns a copy of DEFAULT_ALLOWED_TYPES for undefined input", () => {
    const result = parseAllowedTypes(undefined);
    expect(result).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("returns a copy of DEFAULT_ALLOWED_TYPES for empty string", () => {
    const result = parseAllowedTypes("");
    expect(result).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("returns a copy of DEFAULT_ALLOWED_TYPES for whitespace-only string", () => {
    const result = parseAllowedTypes("  ,  ,  ");
    expect(result).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("parses a single MIME type", () => {
    expect(parseAllowedTypes("image/png")).toEqual(["image/png"]);
  });

  it("parses multiple comma-separated MIME types", () => {
    expect(parseAllowedTypes("image/png,application/pdf")).toEqual(["image/png", "application/pdf"]);
  });

  it("trims whitespace around entries", () => {
    expect(parseAllowedTypes("image/png , application/pdf")).toEqual(["image/png", "application/pdf"]);
  });

  it("lowercases all entries", () => {
    expect(parseAllowedTypes("Image/PNG,Application/PDF")).toEqual(["image/png", "application/pdf"]);
  });

  it("parses wildcard patterns", () => {
    expect(parseAllowedTypes("image/*,text/*")).toEqual(["image/*", "text/*"]);
  });
});

// ============================================================================
// matchesContentType
// ============================================================================

describe("matchesContentType", () => {
  it("matches exact content type", () => {
    expect(matchesContentType("image/png", ["image/png"])).toBe(true);
  });

  it("returns false for non-matching exact type", () => {
    expect(matchesContentType("image/png", ["image/jpeg"])).toBe(false);
  });

  it("matches wildcard image/* against image/png", () => {
    expect(matchesContentType("image/png", ["image/*"])).toBe(true);
  });

  it("matches wildcard image/* against image/jpeg", () => {
    expect(matchesContentType("image/jpeg", ["image/*"])).toBe(true);
  });

  it("does not match image/* against application/pdf", () => {
    expect(matchesContentType("application/pdf", ["image/*"])).toBe(false);
  });

  it("matches glob wildcard * for any type", () => {
    expect(matchesContentType("application/octet-stream", ["*"])).toBe(true);
  });

  it("matches wildcard suffix pattern .*", () => {
    expect(
      matchesContentType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ["application/vnd.openxmlformats-officedocument.*"],
      ),
    ).toBe(true);
  });

  it("is case-insensitive for content type", () => {
    expect(matchesContentType("Image/PNG", ["image/png"])).toBe(true);
  });

  it("returns false for empty allowed list", () => {
    expect(matchesContentType("image/png", [])).toBe(false);
  });

  it("returns true when multiple patterns and one matches", () => {
    expect(matchesContentType("text/plain", ["image/*", "text/*"])).toBe(true);
  });
});

// ============================================================================
// normalizeContentType
// ============================================================================

describe("normalizeContentType", () => {
  it("lowercases content type", () => {
    expect(normalizeContentType("Image/PNG")).toBe("image/png");
  });

  it("trims whitespace", () => {
    expect(normalizeContentType("  image/png  ")).toBe("image/png");
  });

  it("returns application/octet-stream for null", () => {
    expect(normalizeContentType(null)).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for undefined", () => {
    expect(normalizeContentType(undefined)).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for empty string", () => {
    expect(normalizeContentType("")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for whitespace-only string", () => {
    expect(normalizeContentType("   ")).toBe("application/octet-stream");
  });

  it("passes through a valid content type unchanged (lowercased)", () => {
    expect(normalizeContentType("application/json")).toBe("application/json");
  });
});

// ============================================================================
// isInlineAttachmentContentType
// ============================================================================

describe("isInlineAttachmentContentType", () => {
  it("returns true for image/png (matches image/*)", () => {
    expect(isInlineAttachmentContentType("image/png")).toBe(true);
  });

  it("returns true for image/jpeg (matches image/*)", () => {
    expect(isInlineAttachmentContentType("image/jpeg")).toBe(true);
  });

  it("returns true for application/pdf", () => {
    expect(isInlineAttachmentContentType("application/pdf")).toBe(true);
  });

  it("returns true for text/plain", () => {
    expect(isInlineAttachmentContentType("text/plain")).toBe(true);
  });

  it("returns true for text/markdown", () => {
    expect(isInlineAttachmentContentType("text/markdown")).toBe(true);
  });

  it("returns true for application/json", () => {
    expect(isInlineAttachmentContentType("application/json")).toBe(true);
  });

  it("returns false for application/octet-stream", () => {
    expect(isInlineAttachmentContentType("application/octet-stream")).toBe(false);
  });

  it("returns false for application/zip", () => {
    expect(isInlineAttachmentContentType("application/zip")).toBe(false);
  });

  it("INLINE_ATTACHMENT_TYPES constant includes image/*", () => {
    expect(INLINE_ATTACHMENT_TYPES).toContain("image/*");
  });
});
