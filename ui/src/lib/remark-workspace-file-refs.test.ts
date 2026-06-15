import { describe, expect, it } from "vitest";
import {
  buildWorkspaceFileHref,
  parseWorkspaceFileHref,
  remarkWorkspaceFileRefs,
} from "./remark-workspace-file-refs";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

function textNode(value: string): MarkdownNode {
  return { type: "text", value };
}

function inlineCode(value: string): MarkdownNode {
  return { type: "inlineCode", value };
}

function paragraph(children: MarkdownNode[]): MarkdownNode {
  return { type: "paragraph", children };
}

function runPlugin(tree: MarkdownNode): MarkdownNode {
  const transform = remarkWorkspaceFileRefs();
  transform(tree);
  return tree;
}

describe("remarkWorkspaceFileRefs", () => {
  it("converts a matching inline code span into a workspace-file link", () => {
    const tree = paragraph([
      textNode("Check "),
      inlineCode("ui/src/pages/IssueDetail.tsx:42"),
      textNode(" please."),
    ]);
    runPlugin(tree);
    expect(tree.children).toHaveLength(3);
    const link = tree.children![1];
    expect(link.type).toBe("link");
    expect(link.url?.startsWith("workspace-file:")).toBe(true);
    const parsed = parseWorkspaceFileHref(link.url);
    expect(parsed?.path).toBe("ui/src/pages/IssueDetail.tsx");
    expect(parsed?.resourceKind).toBe("file");
    expect(parsed?.line).toBe(42);
  });

  it("does not linkify plain text path mentions outside inline code", () => {
    const tree = paragraph([textNode("see ui/src/pages/IssueDetail.tsx for details")]);
    runPlugin(tree);
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0].type).toBe("text");
  });

  it("does not linkify prose words that look like filenames", () => {
    const tree = paragraph([inlineCode("README.md")]);
    runPlugin(tree);
    expect(tree.children![0].type).toBe("inlineCode");
  });

  it("round-trips workspace file hrefs", () => {
    const href = buildWorkspaceFileHref({ path: "a/b.ts", line: 5, column: 2, raw: "a/b.ts:5:2" });
    const parsed = parseWorkspaceFileHref(href);
    expect(parsed?.path).toBe("a/b.ts");
    expect(parsed?.line).toBe(5);
    expect(parsed?.column).toBe(2);
  });

  it("round-trips workspace folder hrefs", () => {
    const targetPath = "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/";
    const href = buildWorkspaceFileHref({
      path: targetPath,
      resourceKind: "directory",
      line: null,
      column: null,
      raw: targetPath,
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
    });
    const parsed = parseWorkspaceFileHref(href);
    expect(parsed).toMatchObject({
      path: targetPath,
      resourceKind: "directory",
      line: null,
      column: null,
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
    });
  });

  it("converts trailing-slash inline code into workspace folder links", () => {
    const tree = paragraph([
      textNode("Open "),
      inlineCode("content-os/cases/active/2026-06-06-pap-10199-bundled-skills/"),
      textNode("."),
    ]);
    runPlugin(tree);
    const link = tree.children![1];
    expect(link.type).toBe("link");
    expect(parseWorkspaceFileHref(link.url)).toMatchObject({
      path: "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/",
      resourceKind: "directory",
    });
  });

  it("round-trips explicit project workspace identity", () => {
    const targetPath = "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/README.md";
    const href = buildWorkspaceFileHref({
      path: targetPath,
      line: 5,
      column: null,
      raw: `${targetPath}:5`,
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
      projectName: "Paperclip Content",
    });
    const parsed = parseWorkspaceFileHref(href);
    expect(parsed).toMatchObject({
      path: targetPath,
      line: 5,
      column: null,
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
      projectName: "Paperclip Content",
    });
  });

  it("converts linked inline-code file paths into workspace-file links", () => {
    const tree: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "link",
          url: "/PAP/issues/PAP-10306",
          children: [inlineCode("ui/src/a.ts:1")],
        },
      ],
    };
    runPlugin(tree);
    const link = tree.children![0];
    expect(link.type).toBe("link");
    expect(link.url?.startsWith("workspace-file:")).toBe(true);
    expect(parseWorkspaceFileHref(link.url)?.path).toBe("ui/src/a.ts");
  });

  it("does not descend into existing links with mixed labels", () => {
    const tree: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "link",
          url: "https://example.com",
          children: [textNode("see "), inlineCode("ui/src/a.ts:1")],
        },
      ],
    };
    runPlugin(tree);
    const link = tree.children![0];
    expect(link.url).toBe("https://example.com");
    expect(link.children![1]?.type).toBe("inlineCode");
  });
});
