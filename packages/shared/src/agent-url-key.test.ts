import { describe, expect, it } from "vitest";
import { deriveAgentUrlKey, isUuidLike, normalizeAgentUrlKey } from "./agent-url-key.js";

describe("isUuidLike", () => {
  it("accepts canonical v4 UUIDs regardless of case or padding", () => {
    expect(isUuidLike("9b2f52aa-64f2-4b5a-8e2f-1c2d3e4f5a6b")).toBe(true);
    expect(isUuidLike("9B2F52AA-64F2-4B5A-8E2F-1C2D3E4F5A6B")).toBe(true);
    expect(isUuidLike("  9b2f52aa-64f2-4b5a-8e2f-1c2d3e4f5a6b  ")).toBe(true);
  });

  it("rejects non-UUID strings and non-strings", () => {
    expect(isUuidLike("not-a-uuid")).toBe(false);
    expect(isUuidLike("9b2f52aa64f24b5a8e2f1c2d3e4f5a6b")).toBe(false);
    expect(isUuidLike("")).toBe(false);
    expect(isUuidLike(null)).toBe(false);
    expect(isUuidLike(undefined)).toBe(false);
  });

  it("rejects UUIDs with an invalid version or variant nibble", () => {
    // version nibble 0 is outside 1-5
    expect(isUuidLike("9b2f52aa-64f2-0b5a-8e2f-1c2d3e4f5a6b")).toBe(false);
    // variant nibble must be 8, 9, a or b
    expect(isUuidLike("9b2f52aa-64f2-4b5a-0e2f-1c2d3e4f5a6b")).toBe(false);
  });
});

describe("normalizeAgentUrlKey", () => {
  it("lowercases and collapses non-alphanumeric runs into single dashes", () => {
    expect(normalizeAgentUrlKey("Ada Lovelace")).toBe("ada-lovelace");
    expect(normalizeAgentUrlKey("QA -- Bot!!v2")).toBe("qa-bot-v2");
  });

  it("trims leading and trailing dashes produced by normalization", () => {
    expect(normalizeAgentUrlKey("  --Hello World--  ")).toBe("hello-world");
    expect(normalizeAgentUrlKey("(parens)")).toBe("parens");
  });

  it("returns null for empty, symbol-only, or non-string input", () => {
    expect(normalizeAgentUrlKey("")).toBeNull();
    expect(normalizeAgentUrlKey("   ")).toBeNull();
    expect(normalizeAgentUrlKey("!!!")).toBeNull();
    expect(normalizeAgentUrlKey(null)).toBeNull();
    expect(normalizeAgentUrlKey(undefined)).toBeNull();
  });

  it("strips non-ASCII characters into dashes", () => {
    expect(normalizeAgentUrlKey("café crème")).toBe("caf-cr-me");
  });
});

describe("deriveAgentUrlKey", () => {
  it("prefers the normalized name", () => {
    expect(deriveAgentUrlKey("Support Agent", "fallback")).toBe("support-agent");
  });

  it("falls back to the fallback value when the name is unusable", () => {
    expect(deriveAgentUrlKey("!!!", "Backup Name")).toBe("backup-name");
    expect(deriveAgentUrlKey(null, "Backup Name")).toBe("backup-name");
  });

  it("returns the literal 'agent' when nothing is usable", () => {
    expect(deriveAgentUrlKey(null)).toBe("agent");
    expect(deriveAgentUrlKey("", "   ")).toBe("agent");
    expect(deriveAgentUrlKey(undefined, undefined)).toBe("agent");
  });
});
