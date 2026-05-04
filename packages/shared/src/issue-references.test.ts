import { describe, expect, it } from "vitest";
import {
  buildIssueReferenceHref,
  extractIssueReferenceIdentifiers,
  findIssueReferenceMatches,
  normalizeIssueIdentifier,
  parseIssueReferenceHref,
} from "./issue-references.js";

describe("issue references", () => {
  it("normalizes identifiers to uppercase", () => {
    expect(normalizeIssueIdentifier("pap-123")).toBe("PAP-123");
    expect(normalizeIssueIdentifier("not-an-issue")).toBeNull();
  });

  it("parses relative and absolute issue hrefs", () => {
    expect(parseIssueReferenceHref("/issues/PAP-123")).toEqual({ identifier: "PAP-123" });
    expect(parseIssueReferenceHref("/PAP/issues/pap-456")).toEqual({ identifier: "PAP-456" });
    expect(parseIssueReferenceHref("https://paperclip.ing/PAP/issues/pap-789#comment-1")).toEqual({
      identifier: "PAP-789",
    });
    expect(parseIssueReferenceHref("https://paperclip.ing/projects/PAP-789")).toBeNull();
  });

  it("builds canonical issue hrefs", () => {
    expect(buildIssueReferenceHref("pap-123")).toBe("/issues/PAP-123");
  });

  it("finds identifiers and issue paths in plain text", () => {
    expect(findIssueReferenceMatches("See PAP-1, /issues/PAP-2, and https://x.test/PAP/issues/pap-3.")).toEqual([
      { index: 4, length: 5, identifier: "PAP-1", matchedText: "PAP-1" },
      { index: 11, length: 13, identifier: "PAP-2", matchedText: "/issues/PAP-2" },
      {
        index: 30,
        length: 31,
        identifier: "PAP-3",
        matchedText: "https://x.test/PAP/issues/pap-3",
      },
    ]);
  });

  it("trims unmatched square brackets from issue path tokens", () => {
    expect(findIssueReferenceMatches("See /issues/PAP-123] for context.")).toEqual([
      { index: 4, length: 15, identifier: "PAP-123", matchedText: "/issues/PAP-123" },
    ]);
  });

  it("extracts and dedupes references from markdown", () => {
    expect(extractIssueReferenceIdentifiers("PAP-1 [again](/issues/pap-1) PAP-2")).toEqual(["PAP-1", "PAP-2"]);
  });

  it("ignores inline code and fenced code blocks", () => {
    const markdown = [
      "Use PAP-1 here.",
      "",
      "`PAP-2` should not count.",
      "",
      "```md",
      "PAP-3",
      "/issues/PAP-4",
      "```",
      "",
      "Final /issues/PAP-5 mention.",
    ].join("\n");

    expect(extractIssueReferenceIdentifiers(markdown)).toEqual(["PAP-1", "PAP-5"]);
  });
});
