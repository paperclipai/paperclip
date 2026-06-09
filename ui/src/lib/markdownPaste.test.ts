import { describe, expect, it } from "vitest";
import { looksLikeMarkdownPaste, normalizePastedMarkdown } from "./markdownPaste";

describe("markdownPaste", () => {
  it("normalizes windows line endings", () => {
    expect(normalizePastedMarkdown("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("normalizes old mac line endings", () => {
    expect(normalizePastedMarkdown("a\rb\r")).toBe("a\nb\n");
  });

  it("treats markdown blocks as markdown paste", () => {
    expect(looksLikeMarkdownPaste("# Title\n\n- item 1\n- item 2")).toBe(true);
  });

  it("treats a fenced code block as markdown paste", () => {
    expect(looksLikeMarkdownPaste("```\nconst x = 1;\n```")).toBe(true);
  });

  it("treats a tilde fence as markdown paste", () => {
    expect(looksLikeMarkdownPaste("~~~\nraw\n~~~")).toBe(true);
  });

  it("treats a blockquote as markdown paste", () => {
    expect(looksLikeMarkdownPaste("> some quoted text")).toBe(true);
  });

  it("treats an ordered list as markdown paste", () => {
    expect(looksLikeMarkdownPaste("1. first\n2. second")).toBe(true);
  });

  it("treats a table row as markdown paste", () => {
    expect(looksLikeMarkdownPaste("| col1 | col2 |")).toBe(true);
  });

  it("treats horizontal rules as markdown paste", () => {
    expect(looksLikeMarkdownPaste("---")).toBe(true);
    expect(looksLikeMarkdownPaste("***")).toBe(true);
    expect(looksLikeMarkdownPaste("___")).toBe(true);
  });

  it("leaves plain multi-line text on the native paste path", () => {
    expect(looksLikeMarkdownPaste("first paragraph\nsecond paragraph")).toBe(false);
  });

  it("leaves single-line plain text on the native paste path", () => {
    expect(looksLikeMarkdownPaste("just a sentence")).toBe(false);
  });
});
