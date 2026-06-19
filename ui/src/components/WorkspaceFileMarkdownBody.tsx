import type { MouseEvent } from "react";
import { readFileViewerStateFromSearch, useFileViewer } from "@/context/FileViewerContext";
import { parseWorkspaceFileRef } from "@/lib/workspace-file-parser";
import { buildWorkspaceFileHref } from "@/lib/remark-workspace-file-refs";
import { MarkdownBody } from "./MarkdownBody";

type MarkdownBodyProps = Parameters<typeof MarkdownBody>[0];

const INLINE_CODE_RE = /`([^`\r\n]+)`/g;

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/([\\\]])/g, "\\$1");
}

export function linkWorkspaceFileInlineCode(markdown: string, _currentPathname: string, _currentSearch: string, _currentHash: string) {
  return markdown.replace(INLINE_CODE_RE, (token, rawCode: string) => {
    const ref = parseWorkspaceFileRef(rawCode);
    if (!ref) return token;
    return `[\`${escapeMarkdownLinkLabel(ref.raw)}\`](${buildWorkspaceFileHref(ref)})`;
  });
}

export function WorkspaceFileMarkdownBody({
  children,
  ...props
}: MarkdownBodyProps) {
  const viewer = useFileViewer();

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!viewer) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;

    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return;
    const next = readFileViewerStateFromSearch(url.search);
    if (!next) return;

    event.preventDefault();
    viewer.open(next);
  };

  return (
    <div onClick={handleClick}>
      <MarkdownBody {...props} linkWorkspaceFileRefs={!!viewer}>{children}</MarkdownBody>
    </div>
  );
}
