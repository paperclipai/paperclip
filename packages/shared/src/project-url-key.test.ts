import { describe, expect, it } from "vitest";
import { deriveProjectUrlKey, hasNonAsciiContent, normalizeProjectUrlKey } from "./project-url-key.js";

const UUID = "9b2f52aa-64f2-4b5a-8e2f-1c2d3e4f5a6b";
const UUID_SHORT = "9b2f52aa";

describe("normalizeProjectUrlKey", () => {
  it("slugifies mixed-case names with punctuation", () => {
    expect(normalizeProjectUrlKey("My Project (v2)")).toBe("my-project-v2");
    expect(normalizeProjectUrlKey("  Alpha/Beta  ")).toBe("alpha-beta");
  });

  it("returns null for empty or non-string input", () => {
    expect(normalizeProjectUrlKey("")).toBeNull();
    expect(normalizeProjectUrlKey("---")).toBeNull();
    expect(normalizeProjectUrlKey(null)).toBeNull();
    expect(normalizeProjectUrlKey(undefined)).toBeNull();
  });
});

describe("hasNonAsciiContent", () => {
  it("detects non-ASCII characters", () => {
    expect(hasNonAsciiContent("café")).toBe(true);
    expect(hasNonAsciiContent("日本語")).toBe(true);
    expect(hasNonAsciiContent("emoji 🚀")).toBe(true);
  });

  it("returns false for pure ASCII and non-strings", () => {
    expect(hasNonAsciiContent("plain ascii 123!")).toBe(false);
    expect(hasNonAsciiContent("")).toBe(false);
    expect(hasNonAsciiContent(null)).toBe(false);
    expect(hasNonAsciiContent(undefined)).toBe(false);
  });
});

describe("deriveProjectUrlKey", () => {
  it("uses the normalized name when it is fully ASCII", () => {
    expect(deriveProjectUrlKey("Growth Experiments", UUID)).toBe("growth-experiments");
  });

  it("appends a short UUID suffix when non-ASCII content was stripped", () => {
    expect(deriveProjectUrlKey("café projects", UUID)).toBe(`caf-projects-${UUID_SHORT}`);
  });

  it("uses only the short UUID when the name is entirely non-ASCII", () => {
    expect(deriveProjectUrlKey("日本語", UUID)).toBe(UUID_SHORT);
  });

  it("keeps the stripped base without suffix when the fallback is not a UUID", () => {
    expect(deriveProjectUrlKey("café projects", "not-a-uuid")).toBe("caf-projects");
  });

  it("falls back to the normalized fallback when the name is unusable", () => {
    expect(deriveProjectUrlKey(null, "Backup Name")).toBe("backup-name");
    expect(deriveProjectUrlKey("!!!", "Backup Name")).toBe("backup-name");
  });

  it("returns the literal 'project' when nothing is usable", () => {
    expect(deriveProjectUrlKey(null)).toBe("project");
    expect(deriveProjectUrlKey("", "   ")).toBe("project");
  });
});
