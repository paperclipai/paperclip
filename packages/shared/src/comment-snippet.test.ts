import { describe, expect, it } from "vitest";
import { toWellFormedSnippet } from "./comment-snippet.js";

describe("toWellFormedSnippet", () => {
  it("keeps short text unchanged", () => {
    expect(toWellFormedSnippet("hello")).toBe("hello");
  });

  it("keeps a complete emoji inside the limit unchanged", () => {
    expect(toWellFormedSnippet("hi \u{1F600} there")).toBe("hi \u{1F600} there");
  });

  it("replaces a lone high surrogate left by the cut instead of keeping it", () => {
    const body = "x".repeat(119) + "\u{1F600}" + " more";
    expect(toWellFormedSnippet(body)).toBe("x".repeat(119) + "\uFFFD");
  });

  it("replaces a lone surrogate already present in the text", () => {
    expect(toWellFormedSnippet("a\uD800b")).toBe("a\uFFFDb");
    expect(toWellFormedSnippet("a\uDC00b")).toBe("a\uFFFDb");
  });

  it("produces text that survives a JSON round trip without lone surrogates", () => {
    const body = "x".repeat(119) + "\u{1F600}" + " more";
    const snippet = toWellFormedSnippet(body);
    expect(JSON.parse(JSON.stringify(snippet))).toBe(snippet);
    expect(snippet).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it("honors a custom limit", () => {
    expect(toWellFormedSnippet("abcdef", 3)).toBe("abc");
  });
});
