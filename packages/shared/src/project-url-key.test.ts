import { describe, expect, it } from "vitest";
import {
  normalizeProjectUrlKey,
  hasNonAsciiContent,
  deriveProjectUrlKey,
} from "./project-url-key.js";

describe("normalizeProjectUrlKey", () => {
  it("lowercases and replaces delimiters with hyphens", () => {
    expect(normalizeProjectUrlKey("Claude Code Fork")).toBe("claude-code-fork");
  });

  it("trims leading/trailing hyphens", () => {
    expect(normalizeProjectUrlKey("---project---")).toBe("project");
  });

  it("returns null for empty or whitespace-only strings", () => {
    expect(normalizeProjectUrlKey("")).toBe(null);
    expect(normalizeProjectUrlKey("   ")).toBe(null);
  });

  it("returns null for null/undefined", () => {
    expect(normalizeProjectUrlKey(null)).toBe(null);
    expect(normalizeProjectUrlKey(undefined)).toBe(null);
  });

  it("collapses consecutive non-alphanumeric chars", () => {
    expect(normalizeProjectUrlKey("a!!!b")).toBe("a-b");
  });
});

describe("hasNonAsciiContent", () => {
  it("returns false for plain ASCII", () => {
    expect(hasNonAsciiContent("hello world")).toBe(false);
  });

  it("returns true for strings with non-ASCII chars", () => {
    expect(hasNonAsciiContent("café")).toBe(true);
    expect(hasNonAsciiContent("日本語")).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(hasNonAsciiContent(null)).toBe(false);
    expect(hasNonAsciiContent(undefined)).toBe(false);
  });
});

describe("deriveProjectUrlKey", () => {
  it("derives from name when valid ASCII", () => {
    expect(deriveProjectUrlKey("My Project")).toBe("my-project");
  });

  it("appends short UUID suffix for non-ASCII names", () => {
    const key = deriveProjectUrlKey(
      "プロジェクト",
      "7f688d51-cf70-495b-806e-e672e7175da6",
    );
    expect(key).toBe("7f688d51");
  });

  it("falls back to normalized fallback", () => {
    expect(deriveProjectUrlKey(null, "Fallback Name")).toBe("fallback-name");
  });

  it("returns 'project' as last resort", () => {
    expect(deriveProjectUrlKey(null, null)).toBe("project");
  });

  it("handles non-ASCII name with UUID fallback", () => {
    const key = deriveProjectUrlKey("café", "7f688d51-cf70-495b-806e-e672e7175da6");
    expect(key).toBe("caf-7f688d51");
  });
});
