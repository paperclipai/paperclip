import { describe, expect, it } from "vitest";
import { unescapeBlockquoteMarkers } from "./blockquote-markdown";

describe("unescapeBlockquoteMarkers", () => {
  it("leaves markdown without escaped markers untouched", () => {
    expect(unescapeBlockquoteMarkers("> quoted")).toBe("> quoted");
    expect(unescapeBlockquoteMarkers("plain text")).toBe("plain text");
    expect(unescapeBlockquoteMarkers("")).toBe("");
  });

  it("unescapes a single escaped blockquote line", () => {
    expect(unescapeBlockquoteMarkers("\\> see")).toBe("> see");
  });

  it("unescapes multiple escaped blockquote lines", () => {
    expect(unescapeBlockquoteMarkers("\\> line one\n\\> line two")).toBe("> line one\n> line two");
  });

  it("unescapes escaped blockquotes interleaved with normal text", () => {
    expect(unescapeBlockquoteMarkers("hello\n\n\\> quoted\n\nbye")).toBe("hello\n\n> quoted\n\nbye");
  });

  it("preserves leading indentation before the marker", () => {
    expect(unescapeBlockquoteMarkers("  \\> indented")).toBe("  > indented");
  });

  it("does not touch escaped markers inside fenced code blocks", () => {
    const input = "```\n\\> not a quote\n```\n\\> real quote";
    expect(unescapeBlockquoteMarkers(input)).toBe("```\n\\> not a quote\n```\n> real quote");
  });

  it("handles tilde fences", () => {
    const input = "~~~\n\\> literal\n~~~";
    expect(unescapeBlockquoteMarkers(input)).toBe("~~~\n\\> literal\n~~~");
  });

  it("only rewrites the leading marker, not later text", () => {
    expect(unescapeBlockquoteMarkers("\\> a \\> b")).toBe("> a \\> b");
  });

  it("leaves a mid-line escaped marker alone", () => {
    expect(unescapeBlockquoteMarkers("text \\> not a quote")).toBe("text \\> not a quote");
  });
});
