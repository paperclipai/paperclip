import { describe, expect, it } from "vitest";
import { extractIssueResourceLinks, parseIssueResourceLink } from "./issue-resource-links.js";

describe("parseIssueResourceLink", () => {
  it("parses prefixed issue document links", () => {
    expect(parseIssueResourceLink("/PAP/issues/RES-30#document-plan")).toEqual({
      href: "/PAP/issues/RES-30#document-plan",
      issuePathId: "RES-30",
      target: {
        kind: "issue_document",
        documentKey: "plan",
      },
    });
  });

  it("parses work product links with a fallback issue path id", () => {
    expect(parseIssueResourceLink("#work-product-1234", { fallbackIssuePathId: "RES-34" })).toEqual({
      href: "#work-product-1234",
      issuePathId: "RES-34",
      target: {
        kind: "work_product",
        workProductId: "1234",
      },
    });
  });

  it("ignores non-resource hashes", () => {
    expect(parseIssueResourceLink("/PAP/issues/RES-30#comment-1")).toBeNull();
  });
});

describe("extractIssueResourceLinks", () => {
  it("finds both document and work product references", () => {
    expect(
      extractIssueResourceLinks(
        "See [plan](/PAP/issues/RES-30#document-plan) and https://paperclip.test/PAP/issues/RES-30#work-product-abc",
      ),
    ).toEqual([
      {
        href: "/PAP/issues/RES-30#document-plan",
        issuePathId: "RES-30",
        target: {
          kind: "issue_document",
          documentKey: "plan",
        },
      },
      {
        href: "https://paperclip.test/PAP/issues/RES-30#work-product-abc",
        issuePathId: "RES-30",
        target: {
          kind: "work_product",
          workProductId: "abc",
        },
      },
    ]);
  });
});
