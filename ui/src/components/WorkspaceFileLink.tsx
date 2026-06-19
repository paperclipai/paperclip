import type { MouseEvent, ReactNode } from "react";
import { FileCode2, FolderOpen } from "lucide-react";
import { useLocation } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { ParsedWorkspaceFileRef } from "@/lib/workspace-file-parser";
import { formatWorkspaceFileRefDisplay } from "@/lib/workspace-file-parser";
import {
  useFileViewer,
  writeFolderViewerStateToSearch,
  writeFileViewerStateToSearch,
} from "@/context/FileViewerContext";

export interface WorkspaceFileLinkProps {
  workspaceFileRef: ParsedWorkspaceFileRef;
  /** Override the rendered label. Defaults to `path:line:col`. */
  label?: ReactNode;
  className?: string;
  /** Optional override if the consumer wants to customize activation. */
  onOpen?: (ref: ParsedWorkspaceFileRef) => void;
  showIcon?: boolean;
  title?: string;
}

export function WorkspaceFileLink({
  workspaceFileRef,
  label,
  className,
  onOpen,
  showIcon = true,
  title,
}: WorkspaceFileLinkProps) {
  const viewer = useFileViewer();
  const location = useLocation();
  const display = typeof label !== "undefined" ? label : formatWorkspaceFileRefDisplay(workspaceFileRef);
  const canOpen = !!(onOpen || viewer);
  const isDirectory = workspaceFileRef.resourceKind === "directory" || workspaceFileRef.path.endsWith("/");
  const lineSuffix = workspaceFileRef.line
    ? ` line ${workspaceFileRef.line}${workspaceFileRef.column ? ` column ${workspaceFileRef.column}` : ""}`
    : "";
  const ariaLabel = canOpen
    ? `Open ${workspaceFileRef.path}${lineSuffix} in the ${isDirectory ? "workspace browser" : "file viewer"}`
    : `Workspace ${isDirectory ? "folder" : "file"} ${workspaceFileRef.path}${lineSuffix}`;
  const tooltip = title ?? (canOpen
    ? `Open ${workspaceFileRef.path}${lineSuffix} in the ${isDirectory ? "workspace browser" : "file viewer"}`
    : `Workspace ${isDirectory ? "folder" : "file"} ${workspaceFileRef.path}${lineSuffix}`);

  const deepLinkSearch = isDirectory
    ? writeFolderViewerStateToSearch(location.search, {
        path: workspaceFileRef.path,
        projectId: workspaceFileRef.projectId ?? null,
        workspaceId: workspaceFileRef.workspaceId ?? null,
      })
    : writeFileViewerStateToSearch(location.search, {
        path: workspaceFileRef.path,
        line: workspaceFileRef.line ?? null,
        column: workspaceFileRef.column ?? null,
        workspace: "auto",
        projectId: workspaceFileRef.projectId ?? null,
        workspaceId: workspaceFileRef.workspaceId ?? null,
      });
  const href = canOpen
    ? `${location.pathname}${deepLinkSearch}${location.hash}`
    : "#";

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    if (!canOpen) return;
    if (onOpen) onOpen(workspaceFileRef);
    else if (isDirectory) viewer?.openFolder(workspaceFileRef);
    else viewer?.open(workspaceFileRef);
  };

  return (
    <a
      href={href}
      role={canOpen ? "button" : undefined}
      data-workspace-file-link="true"
      data-workspace-file-path={workspaceFileRef.path}
      aria-label={ariaLabel}
      title={tooltip}
      className={cn(
        "paperclip-workspace-file-link inline-flex items-center gap-1 rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-xs leading-tight text-foreground/90 align-baseline no-underline hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        className,
      )}
      onClick={handleClick}
    >
      {showIcon ? (
        isDirectory
          ? <FolderOpen aria-hidden="true" className="h-3 w-3 shrink-0 opacity-70" />
          : <FileCode2 aria-hidden="true" className="h-3 w-3 shrink-0 opacity-70" />
      ) : null}
      <span className="max-w-full whitespace-normal break-all text-left">{display}</span>
    </a>
  );
}
