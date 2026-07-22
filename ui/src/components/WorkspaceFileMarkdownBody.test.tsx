// @vitest-environment node

import { describe, expect, it } from "vitest";
import { linkWorkspaceFileInlineCode } from "./WorkspaceFileMarkdownBody";

describe("linkWorkspaceFileInlineCode", () => {
  it("links workspace file refs in inline code to the current issue file viewer", () => {
    const markdown = linkWorkspaceFileInlineCode(
      "Check `ui/src/pages/IssueDetail.tsx:42` please.",
      "/issues/PAP-1",
      "?tab=chat",
      "#comment-1",
    );

    expect(markdown).toContain("[`ui/src/pages/IssueDetail.tsx:42`](");
    expect(markdown).toContain("workspace-file:?path=ui%2Fsrc%2Fpages%2FIssueDetail.tsx&line=42");
  });

  it("leaves non-file inline code unchanged", () => {
    expect(linkWorkspaceFileInlineCode("Run `pnpm test`.", "/issues/PAP-1", "", "")).toBe("Run `pnpm test`.");
  });

  it("links trailing-slash folder refs to the workspace browser", () => {
    const markdown = linkWorkspaceFileInlineCode(
      "Open `content-os/cases/active/2026-06-06-pap-10199-bundled-skills/`.",
      "/issues/PAP-1",
      "",
      "",
    );

    expect(markdown).toContain("kind=directory");
    expect(markdown).toContain("path=content-os%2Fcases%2Factive%2F2026-06-06-pap-10199-bundled-skills%2F");
  });
});
