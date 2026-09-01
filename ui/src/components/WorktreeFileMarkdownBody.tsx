import { useMemo, type MouseEvent } from "react";
import { readFileViewerStateFromSearch, useFileViewer } from "@/context/FileViewerContext";
import { parseWorktreeFileRef } from "@/lib/worktree-file-parser";
import { buildWorktreeFileHref, type WorktreeFileRefResolver } from "@/lib/remark-worktree-file-refs";
import { worktreeFileAvailabilityRef } from "@/lib/worktree-file-availability";
import { MarkdownBody } from "./MarkdownBody";

type MarkdownBodyProps = Parameters<typeof MarkdownBody>[0];

const INLINE_CODE_RE = /`([^`\r\n]+)`/g;

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/([\\\]])/g, "\\$1");
}

export function linkWorkspaceFileInlineCode(markdown: string, _currentPathname: string, _currentSearch: string, _currentHash: string) {
  return markdown.replace(INLINE_CODE_RE, (token, rawCode: string) => {
    const ref = parseWorktreeFileRef(rawCode);
    if (!ref) return token;
    return `[\`${escapeMarkdownLinkLabel(ref.raw)}\`](${buildWorktreeFileHref(ref)})`;
  });
}

export function WorktreeFileMarkdownBody({
  children,
  ...props
}: MarkdownBodyProps) {
  const viewer = useFileViewer();
  const availability = viewer?.availability;

  // Identity changes with the registry version, so completed batches re-parse
  // the markdown and promote the references that came back openable.
  const resolveWorktreeFileRef = useMemo<WorktreeFileRefResolver | undefined>(() => {
    if (!availability) return undefined;
    return (ref) => {
      const result = availability.check(worktreeFileAvailabilityRef(ref));
      return result.state === "openable" ? result.target : null;
    };
  }, [availability]);

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
      <MarkdownBody {...props} resolveWorkspaceFileRef={resolveWorktreeFileRef}>{children}</MarkdownBody>
    </div>
  );
}
