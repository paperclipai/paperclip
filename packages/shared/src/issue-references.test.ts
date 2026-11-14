import { describe, expect, it } from "vitest";
import {
  buildIssueReferenceHref,
  extractIssueReferenceIdentifiers,
  extractIssueReferenceMatches,
  findIssueReferenceMatches,
  normalizeIssueIdentifier,
  parseIssueReferenceHref,
} from "./issue-references.js";

describe("issue references", () => {
  it.each([findIssueReferenceMatches, extractIssueReferenceMatches, extractIssueReferenceIdentifiers])(
    "scans long alphanumeric runs promptly with %s",
    (extract) => {
      const markdown = `${"a1".repeat(80_000)}\nPAP-1`;
      const startedAt = performance.now();
      expect(extract(markdown)).toHaveLength(1);
      expect(performance.now() - startedAt).toBeLessThan(1500);
    },
  );

  it.each(["/issues/PAP-1", "https://x.test/issues/PAP-1"])(
    "trims long unmatched bracket suffixes promptly from %s",
    (path) => {
      const startedAt = performance.now();
      expect(extractIssueReferenceMatches(path + "]".repeat(160_000))).toEqual([
        { index: 0, length: path.length, identifier: "PAP-1", matchedText: path },
      ]);
      expect(performance.now() - startedAt).toBeLessThan(1500);
    },
  );

  it("preserves references embedded in alphanumeric runs and balanced path brackets", () => {
    expect(findIssueReferenceMatches("12pap-5 PAP-1PAP-2")).toEqual([
      { index: 2, length: 5, identifier: "PAP-5", matchedText: "pap-5" },
      { index: 8, length: 5, identifier: "PAP-1", matchedText: "PAP-1" },
      { index: 13, length: 5, identifier: "PAP-2", matchedText: "PAP-2" },
    ]);
    const path = "/issues/PAP-1?q=[value]";
    expect(findIssueReferenceMatches(`${path}].!`)).toEqual([
      { index: 0, length: path.length, identifier: "PAP-1", matchedText: path },
    ]);
  });

  it("normalizes identifiers to uppercase", () => {
    expect(normalizeIssueIdentifier("pap-123")).toBe("PAP-123");
    expect(normalizeIssueIdentifier("pc1a2-7")).toBe("PC1A2-7");
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
    expect(findIssueReferenceMatches("See PAP-1, /issues/PC1A2-2, and https://x.test/PAP/issues/pc1a2-3.")).toEqual([
      { index: 4, length: 5, identifier: "PAP-1", matchedText: "PAP-1" },
      { index: 11, length: 15, identifier: "PC1A2-2", matchedText: "/issues/PC1A2-2" },
      {
        index: 32,
        length: 33,
        identifier: "PC1A2-3",
        matchedText: "https://x.test/PAP/issues/pc1a2-3",
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
