import type { MouseEvent, ReactNode } from "react";
import { FileCode2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkspaceFileRef } from "@paperclipai/shared";
import { useFileViewer } from "@/context/FileViewerContext";

export interface ArtifactFileChipProps {
  workspaceFileRef: WorkspaceFileRef;
  /** Override the rendered label. Defaults to the display path. */
  label?: ReactNode;
  className?: string;
  /** Optional override if the consumer wants to customize activation. */
  onOpen?: (ref: WorkspaceFileRef) => void;
  showIcon?: boolean;
  title?: string;
}

function artifactFileDisplay(ref: WorkspaceFileRef) {
  if (!ref.projectName) return ref.displayPath;
  const prefix = `${ref.projectName} / `;
  return ref.displayPath.startsWith(prefix) ? ref.displayPath : `${prefix}${ref.displayPath}`;
}

export function ArtifactFileChip({
  workspaceFileRef,
  label,
  className,
  onOpen,
  showIcon = true,
  title,
}: ArtifactFileChipProps) {
  const viewer = useFileViewer();
  const display = typeof label !== "undefined" ? label : artifactFileDisplay(workspaceFileRef);
  const canOpen = !!(onOpen || viewer);
  const lineSuffix = workspaceFileRef.line
    ? ` line ${workspaceFileRef.line}${workspaceFileRef.column ? ` column ${workspaceFileRef.column}` : ""}`
    : "";
  const ariaLabel = canOpen
    ? `Open ${workspaceFileRef.displayPath}${lineSuffix} in the file viewer`
    : `Workspace file ${workspaceFileRef.displayPath}${lineSuffix}`;
  const tooltip = title ?? (canOpen
    ? `Open ${workspaceFileRef.displayPath}${lineSuffix} in the file viewer`
    : `Workspace file ${workspaceFileRef.displayPath}${lineSuffix}`);

  const classNames = cn(
    "paperclip-artifact-file-chip inline-flex items-center gap-1 rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-xs leading-tight text-foreground/90 align-baseline no-underline hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
    canOpen ? "cursor-pointer" : null,
    className,
  );
  const content = (
    <>
      {showIcon ? <FileCode2 aria-hidden="true" className="h-3 w-3 shrink-0 opacity-70" /> : null}
      <span className="max-w-full whitespace-normal break-all text-left">{display}</span>
    </>
  );

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (event.button !== 0) return;
    if (onOpen) onOpen(workspaceFileRef);
    else {
      const workspace = workspaceFileRef.workspaceKind === "execution_workspace" ? "execution" : "project";
      viewer?.open({
        path: workspaceFileRef.relativePath,
        line: workspaceFileRef.line ?? null,
        column: workspaceFileRef.column ?? null,
        workspace,
        projectId: workspaceFileRef.projectId ?? null,
        workspaceId: workspaceFileRef.projectId ? workspaceFileRef.workspaceId : null,
      });
    }
  };

  if (!canOpen) {
    return (
      <span
        data-artifact-file-chip="true"
        data-workspace-file-path={workspaceFileRef.relativePath}
        aria-label={ariaLabel}
        title={tooltip}
        className={classNames}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-artifact-file-chip="true"
      data-workspace-file-path={workspaceFileRef.relativePath}
      aria-label={ariaLabel}
      title={tooltip}
      className={classNames}
      onClick={handleClick}
    >
      {content}
    </button>
  );
}
