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
  it("keeps extracting identifiers glued to digits and hashes exactly as before", () => {
    // These shapes come from the #15998 analysis: the old pattern found
    // tokens inside alphanumeric runs, and the linear pattern must keep
    // finding the same ones.
    expect(extractIssueReferenceIdentifiers("run 7c9e6679-7425-40de-944b-e07fc1f90ae7 ok")).toEqual([
      "C9E6679-7425",
      "DE-944",
    ]);
    expect(extractIssueReferenceIdentifiers("commit 3f2c1d9-2")).toEqual(["F2C1D9-2"]);
    expect(extractIssueReferenceIdentifiers("12PAP-5")).toEqual(["PAP-5"]);
    expect(extractIssueReferenceIdentifiers("PAP-1PAP-2")).toEqual(["PAP-1", "PAP-2"]);
    expect(extractIssueReferenceIdentifiers("AB-CD-12")).toEqual(["CD-12"]);
  });

  it("stays fast on one long alphanumeric run", () => {
    // A 200k hex-style run took ~30s with the old quadratic pattern; the
    // test simply completing inside the normal timeout is the regression
    // signal, and the real reference after the run must still be found.
    const body = "Manifest:\n" + "a1b2c3d4".repeat(25_000) + "\nSee PAP-1.";
    expect(extractIssueReferenceIdentifiers(body)).toEqual(["PAP-1"]);
  });

  it("stays fast on a token that ends in a long bracket run", () => {
    expect(extractIssueReferenceIdentifiers("/" + "]".repeat(20_000))).toEqual([]);
    expect(extractIssueReferenceIdentifiers("see (PAP-9)")).toEqual(["PAP-9"]);
  });
});
