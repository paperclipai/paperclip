import { describe, it, expect } from "vitest";
import { normalizeMarkdown } from "./normalize-markdown";

describe("normalizeMarkdown", () => {
  it("strips common leading whitespace (dedent)", () => {
    const input = "    # Title\n    \n    Some text\n    - Item 1\n    - Item 2";
    const expected = "# Title\n\nSome text\n- Item 1\n- Item 2";
    expect(normalizeMarkdown(input)).toBe(expected);
  });

  it("preserves relative indentation within dedented content", () => {
    const input = "  # Title\n  \n  Some text\n      code block\n  More text";
    const expected = "# Title\n\nSome text\n    code block\nMore text";
    expect(normalizeMarkdown(input)).toBe(expected);
  });

  it("normalizes CRLF to LF", () => {
    const input = "line one\r\nline two\r\nline three";
    const expected = "line one\nline two\nline three";
    expect(normalizeMarkdown(input)).toBe(expected);
  });

  it("normalizes bare CR to LF", () => {
    const input = "line one\rline two\rline three";
    const expected = "line one\nline two\nline three";
    expect(normalizeMarkdown(input)).toBe(expected);
  });

  it("returns single-line input unchanged", () => {
    const input = "  just one line";
    expect(normalizeMarkdown(input)).toBe("  just one line");
  });

  it("returns text unchanged when no common indent", () => {
    const input = "# Title\n\nNo indent here\n- list item";
    expect(normalizeMarkdown(input)).toBe(input);
  });

  it("handles empty lines in indented content", () => {
    const input = "    line one\n\n    line two\n    \n    line three";
    const expected = "line one\n\nline two\n\nline three";
    expect(normalizeMarkdown(input)).toBe(expected);
  });

  it("returns empty string unchanged", () => {
    expect(normalizeMarkdown("")).toBe("");
  });

  it("handles mixed indent levels correctly", () => {
    const input = "  base\n    nested\n  back\n      deep";
    const expected = "base\n  nested\nback\n    deep";
    expect(normalizeMarkdown(input)).toBe(expected);
  });

  it("leaves mixed tab and space indentation unchanged", () => {
    const input = "\t# Title\n    body\n\t- item";
    expect(normalizeMarkdown(input)).toBe(input);
  });
});
