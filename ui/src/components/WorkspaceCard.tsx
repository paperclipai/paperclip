import { Link } from "../lib/router";
import { type ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { projectWorkspaceUrl } from "../lib/utils";
import { CopyText } from "./CopyText";
import { Copy, FolderOpen, GitBranch, Github, Loader2, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "../lib/timeAgo";

export interface WorkspaceCardProps {
  id: string;
  key: string;
  href: string;
  name: string;
  description?: string | null;
  isPrimary: boolean;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  branchName?: string | null;
  /** Service indicator: { running, total } */
  services?: { running: number; total: number } | null;
  /** Status badge text (e.g. "active", "archived") */
  statusBadge?: string | null;
  /** Timestamp label */
  timeAgoLabel?: string | null;
  /** Show start/stop button */
  runtimeAction?: {
    isPending: boolean;
    isRunning: boolean;
    onAction: () => void;
  } | null;
  /** Show close/retry button */
  closeAction?: {
    label: string;
    onClick: () => void;
  } | null;
  /** Show delete button */
  deleteAction?: {
    isPending: boolean;
    onDelete: () => void;
  } | null;
  /** Issue links at bottom */
  issues?: Array<{ id: string; identifier?: string | null }> | null;
}

function truncatePath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

export function WorkspaceCard({
  id,
  href,
  name,
  description,
  isPrimary,
  cwd,
  repoUrl,
  branchName,
  services,
  statusBadge,
  timeAgoLabel,
  runtimeAction,
  closeAction,
  deleteAction,
  issues,
}: WorkspaceCardProps) {
  const hasRunningServices = services ? services.running > 0 : false;

  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      {/* Header row: name + badges + actions */}
      <div className="flex items-center gap-3">
        <Link
          to={href}
          className="min-w-0 shrink truncate text-sm font-medium hover:underline"
        >
          {name}
        </Link>

        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {isPrimary && (
            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-500">primary</span>
          )}
          {services && services.total > 0 ? (
            <span className={`inline-flex items-center gap-1 ${hasRunningServices ? "text-emerald-500" : ""}`}>
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${hasRunningServices ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
              {services.running}/{services.total}
            </span>
          ) : null}
          {statusBadge ? (
            <span className="text-[11px] text-muted-foreground">{statusBadge}</span>
          ) : null}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {timeAgoLabel && (
            <span className="text-xs text-muted-foreground">{timeAgoLabel}</span>
          )}
          {runtimeAction && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={runtimeAction.isPending}
              onClick={runtimeAction.onAction}
            >
              {runtimeAction.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : runtimeAction.isRunning ? (
                <Square className="h-3 w-3" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {runtimeAction.isRunning ? "Stop" : "Start"}
            </Button>
          )}
          {closeAction && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={closeAction.onClick}
            >
              {closeAction.label}
            </Button>
          )}
          {deleteAction && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              disabled={deleteAction.isPending}
              onClick={deleteAction.onDelete}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Description */}
      {description && (
        <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
          {description}
        </div>
      )}

      {/* Metadata lines */}
      {(cwd || repoUrl || branchName) && (
        <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
          {branchName && (
            <div className="flex items-center gap-1.5">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="font-mono">{branchName}</span>
            </div>
          )}
          {cwd && (
            <div className="flex items-center gap-1.5">
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono" title={cwd}>
                {truncatePath(cwd)}
              </span>
              <CopyText text={cwd} className="shrink-0" copiedLabel="Path copied">
                <Copy className="h-3 w-3" />
              </CopyText>
            </div>
          )}
          {repoUrl && (
            <div className="flex items-center gap-1.5">
              <Github className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono" title={repoUrl}>
                {repoUrl}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Issues */}
      {issues && issues.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-muted-foreground/70">Issues</span>
          {issues.map((issue) => (
            <Link
              key={issue.id}
              to={`/issues/${issue.identifier ?? issue.id}`}
              className="font-mono hover:text-foreground hover:underline"
            >
              {issue.identifier ?? issue.id.slice(0, 8)}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Build card props from a summary (execution workspace with activity) */
export function summaryToCardProps(
  summary: ProjectWorkspaceSummary,
  projectRef: string,
  opts?: {
    runtimeAction?: { isPending: boolean; isRunning: boolean; onAction: () => void } | null;
    closeAction?: { label: string; onClick: () => void } | null;
  },
): WorkspaceCardProps {
  const hasRunningServices = summary.runningServiceCount > 0;
  return {
    id: summary.workspaceId,
    key: summary.key,
    href: summary.kind === "project_workspace"
      ? projectWorkspaceUrl({ id: projectRef, urlKey: projectRef }, summary.workspaceId)
      : `/execution-workspaces/${summary.workspaceId}`,
    name: summary.workspaceName,
    isPrimary: false,
    cwd: summary.cwd,
    branchName: summary.branchName,
    services: summary.serviceCount > 0
      ? { running: summary.runningServiceCount, total: summary.serviceCount }
      : null,
    statusBadge: summary.executionWorkspaceStatus && summary.executionWorkspaceStatus !== "active"
      ? summary.executionWorkspaceStatus
      : null,
    timeAgoLabel: timeAgo(summary.lastUpdatedAt),
    runtimeAction: opts?.runtimeAction,
    closeAction: opts?.closeAction,
    issues: summary.issues,
  };
}

/** Build card props from a configured workspace (may have no activity) */
export function workspaceToCardProps(
  workspace: { id: string; name: string; isPrimary: boolean; cwd?: string | null; repoUrl?: string | null; repoRef?: string | null },
  projectRef: string,
  opts?: {
    deleteAction?: { isPending: boolean; onDelete: () => void } | null;
  },
): WorkspaceCardProps {
  return {
    id: workspace.id,
    key: `project:${workspace.id}`,
    href: projectWorkspaceUrl({ id: projectRef, urlKey: projectRef }, workspace.id),
    name: workspace.name,
    isPrimary: workspace.isPrimary,
    cwd: workspace.cwd,
    repoUrl: workspace.repoUrl,
    repoRef: workspace.repoRef,
    deleteAction: opts?.deleteAction,
  };
}
