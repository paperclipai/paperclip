import { describe, expect, it } from "vitest";
import { parseCaseReferenceFromHref, remarkLinkCaseReferences } from "./case-reference";

describe("parseCaseReferenceFromHref", () => {
  it("linkifies a bare case identifier to the case detail path", () => {
    expect(parseCaseReferenceFromHref("PAP-C7")).toEqual({
      identifier: "PAP-C7",
      href: "/cases/PAP-C7",
    });
  });

  it("normalizes case to upper", () => {
    expect(parseCaseReferenceFromHref("pap-c12")?.identifier).toBe("PAP-C12");
  });

  it("ignores plain issue identifiers (no -C infix)", () => {
    expect(parseCaseReferenceFromHref("PAP-123")).toBeNull();
    expect(parseCaseReferenceFromHref("PAP-7")).toBeNull();
  });

  it("respects the known-prefix allowlist when provided", () => {
    expect(parseCaseReferenceFromHref("FOO-C1", new Set(["PAP"]))).toBeNull();
    expect(parseCaseReferenceFromHref("PAP-C1", new Set(["PAP"]))?.identifier).toBe("PAP-C1");
  });

  it("stays permissive when no prefixes are known", () => {
    expect(parseCaseReferenceFromHref("FOO-C1")?.identifier).toBe("FOO-C1");
  });
});

describe("remarkLinkCaseReferences", () => {
  it("rewrites a bare token inside a text node into a link node", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "see PAP-C7 for details" }],
        },
      ],
    };
    remarkLinkCaseReferences()(tree as never);
    const paragraph = (tree.children[0] as { children: Array<{ type: string; url?: string }> });
    const link = paragraph.children.find((c) => c.type === "link");
    expect(link?.url).toBe("/cases/PAP-C7");
    // Surrounding text is preserved on both sides.
    expect(paragraph.children[0]).toMatchObject({ type: "text", value: "see " });
    expect(paragraph.children.at(-1)).toMatchObject({ type: "text", value: " for details" });
  });

  it("rewrites inline code that is exactly a case identifier", () => {
    const tree = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "inlineCode", value: "PAP-C42" }] },
      ],
    };
    remarkLinkCaseReferences()(tree as never);
    const paragraph = tree.children[0] as { children: Array<{ type: string; url?: string }> };
    expect(paragraph.children[0]).toMatchObject({ type: "link", url: "/cases/PAP-C42" });
  });

  it("does not descend into existing links", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "link",
          url: "https://example.com",
          children: [{ type: "text", value: "PAP-C7" }],
        },
      ],
    };
    remarkLinkCaseReferences()(tree as never);
    const link = tree.children[0] as { url: string; children: Array<{ type: string }> };
    expect(link.url).toBe("https://example.com");
    expect(link.children[0]!.type).toBe("text");
  });
});
