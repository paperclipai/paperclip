import { describe, expect, it } from "vitest";
import { firstNonEmptyLine } from "./utils.js";

describe("firstNonEmptyLine", () => {
  it("returns the first non-empty line from a multi-line string", () => {
    expect(firstNonEmptyLine("hello\nworld")).toBe("hello");
  });

  it("skips leading blank lines", () => {
    expect(firstNonEmptyLine("\n\nhello\nworld")).toBe("hello");
  });

  it("trims whitespace from lines when finding the first non-empty", () => {
    expect(firstNonEmptyLine("   \n  content  \nother")).toBe("content");
  });

  it("returns an empty string for an all-blank input", () => {
    expect(firstNonEmptyLine("\n\n   \n")).toBe("");
  });

  it("returns an empty string for an empty input", () => {
    expect(firstNonEmptyLine("")).toBe("");
  });

  it("handles Windows-style CRLF line endings", () => {
    expect(firstNonEmptyLine("\r\nfirst line\r\nsecond line")).toBe("first line");
  });

  it("returns the sole line when there is only one", () => {
    expect(firstNonEmptyLine("only line")).toBe("only line");
  });
});
