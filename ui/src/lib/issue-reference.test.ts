import { describe, expect, it } from "vitest";
import { parseIssuePathIdFromPath, parseIssueReferenceFromHref, remarkLinkIssueReferences } from "./issue-reference";

type TreeNode = { type: string; value?: string; url?: string; children?: TreeNode[] };

function paragraph(value: string): TreeNode {
  return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] };
}

function paragraphChildren(tree: TreeNode): TreeNode[] {
  return tree.children?.[0]?.children ?? [];
}

describe("issue-reference", () => {
  it("extracts issue ids from company-scoped issue paths", () => {
    expect(parseIssuePathIdFromPath("/PAP/issues/PAP-1271")).toBe("PAP-1271");
    expect(parseIssuePathIdFromPath("/PAP/issues/pap-1272")).toBe("PAP-1272");
    expect(parseIssuePathIdFromPath("/issues/pc1a2-7")).toBe("PC1A2-7");
    expect(parseIssuePathIdFromPath("/PC1A2/issues/pc1a2-7")).toBe("PC1A2-7");
    expect(parseIssuePathIdFromPath("/issues/PAP-1179")).toBe("PAP-1179");
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
  });

  it("does not treat full issue URLs as internal issue paths", () => {
    expect(parseIssuePathIdFromPath("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssuePathIdFromPath("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("does not treat GitHub issue URLs as internal Paperclip issue links", () => {
    expect(parseIssuePathIdFromPath("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
    expect(parseIssueReferenceFromHref("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
  });

  it("ignores placeholder issue paths", () => {
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
    expect(parseIssuePathIdFromPath("http://localhost:3100/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
  });

  it("normalizes bare identifiers, relative issue paths, and issue scheme links into internal links", () => {
    expect(parseIssueReferenceFromHref("pap-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
    expect(parseIssueReferenceFromHref("pc1a2-7")).toEqual({
      issuePathId: "PC1A2-7",
      href: "/issues/PC1A2-7",
    });
    expect(parseIssueReferenceFromHref("/PAP/issues/pap-1180")).toEqual({
      issuePathId: "PAP-1180",
      href: "/issues/PAP-1180",
    });
    expect(parseIssueReferenceFromHref("issue://PAP-1310")).toEqual({
      issuePathId: "PAP-1310",
      href: "/issues/PAP-1310",
    });
    expect(parseIssueReferenceFromHref("issue://:PAP-1311")).toEqual({
      issuePathId: "PAP-1311",
      href: "/issues/PAP-1311",
    });
  });

  it("normalizes exact inline-code-like issue identifiers", () => {
    expect(parseIssueReferenceFromHref("PAP-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
  });

  it("preserves absolute Paperclip issue URLs so origin, port, and hash are not lost", () => {
    expect(parseIssueReferenceFromHref("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssueReferenceFromHref("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("ignores literal route placeholder paths", () => {
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("http://localhost:3100/api/issues/:id")).toBeNull();
  });

  describe("known-prefix gating", () => {
    it("links a bare identifier whose prefix is known", () => {
      expect(parseIssueReferenceFromHref("PAP-1271", new Set(["PAP"]))).toEqual({
        issuePathId: "PAP-1271",
        href: "/issues/PAP-1271",
      });
    });

    it("matches the prefix case-insensitively", () => {
      expect(parseIssueReferenceFromHref("pap-12", new Set(["PAP"]))).toEqual({
        issuePathId: "PAP-12",
        href: "/issues/PAP-12",
      });
    });

    it("does not link a bare identifier whose prefix is unknown (e.g. a Jira key)", () => {
      expect(parseIssueReferenceFromHref("JIRA-456", new Set(["PAP"]))).toBeNull();
    });

    it("stays permissive when no prefix set is supplied", () => {
      expect(parseIssueReferenceFromHref("FOO-1")).toEqual({
        issuePathId: "FOO-1",
        href: "/issues/FOO-1",
      });
    });

    it("stays permissive when the prefix set is empty", () => {
      expect(parseIssueReferenceFromHref("FOO-1", new Set())).toEqual({
        issuePathId: "FOO-1",
        href: "/issues/FOO-1",
      });
    });

    it("never gates explicit issue:// scheme references", () => {
      expect(parseIssueReferenceFromHref("issue://ACME-9", new Set(["PAP"]))).toEqual({
        issuePathId: "ACME-9",
        href: "/issues/ACME-9",
      });
    });

    it("never gates explicit /issues/ path references", () => {
      expect(parseIssueReferenceFromHref("/ACME/issues/ACME-9", new Set(["PAP"]))).toEqual({
        issuePathId: "ACME-9",
        href: "/issues/ACME-9",
      });
    });
  });

  describe("remarkLinkIssueReferences", () => {
    it("links only known-prefix tokens and leaves foreign keys as text", () => {
      const tree = paragraph("See PAP-1 and JIRA-2 today.");
      remarkLinkIssueReferences({ knownPrefixes: ["PAP"] })(tree);

      const children = paragraphChildren(tree);
      expect(children).toEqual([
        { type: "text", value: "See " },
        { type: "link", url: "/issues/PAP-1", children: [{ type: "text", value: "PAP-1" }] },
        { type: "text", value: " and JIRA-2 today." },
      ]);
    });

    it("links every identifier when no prefixes are supplied (legacy permissive)", () => {
      const tree = paragraph("See PAP-1 and JIRA-2.");
      remarkLinkIssueReferences()(tree);

      const links = paragraphChildren(tree).filter((node) => node.type === "link");
      expect(links.map((node) => node.url)).toEqual(["/issues/PAP-1", "/issues/JIRA-2"]);
    });
  });
});
