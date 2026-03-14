import { describe, expect, it } from "vitest";
import { extractMentionTokens } from "../services/issues.js";

describe("extractMentionTokens", () => {
  it("extracts a single-word mention", () => {
    const tokens = extractMentionTokens("Hey @CTO can you review?");
    expect(tokens.has("cto")).toBe(true);
  });

  it("extracts a hyphenated slug and adds the space variant", () => {
    const tokens = extractMentionTokens("@code-reviewer please review");
    expect(tokens.has("code-reviewer")).toBe(true);
    expect(tokens.has("code reviewer")).toBe(true);
  });

  it("handles multiple mentions in one body", () => {
    const tokens = extractMentionTokens(
      "@backend-engineer and @frontend-engineer please check",
    );
    expect(tokens.has("backend engineer")).toBe(true);
    expect(tokens.has("frontend engineer")).toBe(true);
  });

  it("ignores emails (user@example.com) via \\B guard", () => {
    const tokens = extractMentionTokens("Email user@example.com for help");
    expect(tokens.size).toBe(0);
  });

  it("returns an empty set for text with no mentions", () => {
    const tokens = extractMentionTokens("No mentions here at all.");
    expect(tokens.size).toBe(0);
  });

  it("normalises mentions to lowercase", () => {
    const tokens = extractMentionTokens("Ask @Backend-Engineer for help");
    expect(tokens.has("backend-engineer")).toBe(true);
    expect(tokens.has("backend engineer")).toBe(true);
  });

  it("handles multi-hyphen slugs", () => {
    const tokens = extractMentionTokens("CC @full-stack-engineer on this");
    expect(tokens.has("full-stack-engineer")).toBe(true);
    expect(tokens.has("full stack engineer")).toBe(true);
  });

  it("matches standalone @example.com (\\B guard only blocks word-char before @)", () => {
    // \B matches between two non-word characters (space + @), so a
    // standalone "@example.com" after whitespace IS extracted as "example".
    // The \B guard only prevents matching when @ is preceded by a word
    // character, e.g. "user@example.com".
    const tokens = extractMentionTokens("see docs at @example.com");
    expect(tokens.has("example")).toBe(true);
  });
});
