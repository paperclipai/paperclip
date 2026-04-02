import { describe, expect, it } from "vitest";
import { looksLikeMarkdownPaste, normalizePastedMarkdown } from "./markdownPaste";

describe("markdownPaste", () => {
  it("normalizes windows line endings", () => {
    expect(normalizePastedMarkdown("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("treats markdown blocks as markdown paste", () => {
    expect(looksLikeMarkdownPaste("# Title\n\n- item 1\n- item 2")).toBe(true);
  });

  it("leaves plain multi-line text on the native paste path", () => {
    expect(looksLikeMarkdownPaste("first paragraph\nsecond paragraph")).toBe(false);
  });

  it("leaves single-line plain text on the native paste path", () => {
    expect(looksLikeMarkdownPaste("just a sentence")).toBe(false);
  });
});
