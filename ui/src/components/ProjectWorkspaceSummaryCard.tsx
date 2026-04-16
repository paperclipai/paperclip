import { Link } from "@/lib/router";
import type { ExecutionWorkspace, Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { CopyText } from "./CopyText";
import { IssuesQuicklook } from "./IssuesQuicklook";
import type { ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { cn, projectWorkspaceUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Copy, ExternalLink, FolderOpen, GitBranch, Loader2, Play, Square } from "lucide-react";
import { useLocale } from "../context/LocaleContext";

function workspaceKindLabel(kind: ProjectWorkspaceSummary["kind"], t: (key: string, variables?: Record<string, unknown>) => string) {
  return kind === "execution_workspace"
    ? t("projectWorkspaceSummary.executionWorkspace")
    : t("projectWorkspaceSummary.projectWorkspace");
}

function workspaceStatusLabel(
  status: ExecutionWorkspace["status"],
  t: (key: string, variables?: Record<string, unknown>) => string,
) {
  if (status === "active") return t("projectDetail.executionWorkspaceStatus.active");
  if (status === "idle") return t("projectDetail.executionWorkspaceStatus.idle");
  if (status === "in_review") return t("projectDetail.executionWorkspaceStatus.inReview");
  if (status === "archived") return t("projectDetail.executionWorkspaceStatus.archived");
  if (status === "cleanup_failed") return t("projectDetail.executionWorkspaceStatus.cleanupFailed");
  return String(status).replace(/_/g, " ");
}

function truncatePath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

interface ProjectWorkspaceSummaryCardProps {
  projectRef: string;
  summary: ProjectWorkspaceSummary;
  runtimeActionKey: string | null;
  runtimeActionPending: boolean;
  onRuntimeAction: (input: {
    key: string;
    kind: "project_workspace" | "execution_workspace";
    workspaceId: string;
    action: "start" | "stop" | "restart";
  }) => void;
  onCloseWorkspace: (input: {
    id: string;
    name: string;
    status: ExecutionWorkspace["status"];
  }) => void;
}

export function ProjectWorkspaceSummaryCard({
  projectRef,
  summary,
  runtimeActionKey,
  runtimeActionPending,
  onRuntimeAction,
  onCloseWorkspace,
}: ProjectWorkspaceSummaryCardProps) {
  const { t } = useLocale();
  const visibleIssues = summary.issues.slice(0, 4);
  const hiddenIssueCount = Math.max(summary.issues.length - visibleIssues.length, 0);
  const workspaceHref =
    summary.kind === "project_workspace"
      ? projectWorkspaceUrl({ id: projectRef, urlKey: projectRef }, summary.workspaceId)
      : `/execution-workspaces/${summary.workspaceId}`;
  const hasRunningServices = summary.runningServiceCount > 0;
  const actionKey = `${summary.key}:${hasRunningServices ? "stop" : "start"}`;

  return (
    <div className="border-b border-border px-4 py-4 last:border-b-0 sm:px-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-border bg-muted/25 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {workspaceKindLabel(summary.kind, t)}
              </span>
              <span className="inline-flex items-center rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground">
                {t("projectWorkspaceSummary.updatedAgo", { time: timeAgo(summary.lastUpdatedAt) })}
              </span>
              {summary.serviceCount > 0 ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                    hasRunningServices
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-border/70 bg-background text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      hasRunningServices ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                  {t("projectWorkspaceSummary.serviceCountSummary", {
                    running: summary.runningServiceCount,
                    total: summary.serviceCount,
                  })}
                </span>
              ) : null}
              {summary.executionWorkspaceStatus ? (
                <span className="inline-flex items-center rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground">
                  {workspaceStatusLabel(summary.executionWorkspaceStatus, t)}
                </span>
              ) : null}
            </div>
            <Link
              to={workspaceHref}
              className="block break-words text-base font-semibold leading-6 text-foreground hover:underline"
            >
              {summary.workspaceName}
            </Link>
          </div>

          <div
            className="flex flex-col gap-2 min-[420px]:flex-row lg:w-auto lg:justify-end"
            data-testid="workspace-summary-actions"
          >
            {summary.hasRuntimeConfig ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 justify-center px-3 text-xs"
                disabled={runtimeActionPending}
                onClick={() =>
                  onRuntimeAction({
                    key: summary.key,
                    kind: summary.kind,
                    workspaceId: summary.workspaceId,
                    action: hasRunningServices ? "stop" : "start",
                  })
                }
              >
                {runtimeActionKey === actionKey ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : hasRunningServices ? (
                  <Square className="mr-2 h-3.5 w-3.5" />
                ) : (
                  <Play className="mr-2 h-3.5 w-3.5" />
                )}
                {hasRunningServices ? t("projectWorkspaceSummary.stopServices") : t("projectWorkspaceSummary.startServices")}
              </Button>
            ) : null}
            {summary.kind === "execution_workspace" && summary.executionWorkspaceId && summary.executionWorkspaceStatus ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-3 text-xs text-muted-foreground"
                onClick={() => onCloseWorkspace({
                  id: summary.executionWorkspaceId!,
                  name: summary.workspaceName,
                  status: summary.executionWorkspaceStatus!,
                })}
              >
                {summary.executionWorkspaceStatus === "cleanup_failed"
                  ? t("projectDetail.retryClose")
                  : t("executionWorkspaceDetail.closeWorkspace")}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-border/70 bg-muted/15 px-3 py-3">
          <div className="space-y-2 text-sm">
            {summary.branchName ? (
              <div className="flex items-start gap-2">
                <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {t("projectWorkspaceSummary.branch")}
                  </div>
                  <div className="break-all font-mono text-xs text-foreground">{summary.branchName}</div>
                </div>
              </div>
            ) : null}

            {summary.cwd ? (
              <div className="flex items-start gap-2">
                <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {t("projectWorkspaceSummary.path")}
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 break-all font-mono text-xs text-foreground" title={summary.cwd}>
                      {truncatePath(summary.cwd)}
                    </span>
                    <CopyText
                      text={summary.cwd}
                      className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                      copiedLabel={t("projectDetail.pathCopied")}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </div>
                </div>
              </div>
            ) : null}

            {summary.primaryServiceUrl ? (
              <div className="flex items-start gap-2">
                <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {t("projectWorkspaceSummary.serviceLabel")}
                  </div>
                  <a
                    href={summary.primaryServiceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-mono text-xs text-foreground hover:underline"
                  >
                    {summary.primaryServiceUrl}
                  </a>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {summary.issues.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t("projectWorkspaceSummary.linkedIssues")}
            </div>
            <div className="flex flex-wrap gap-2">
              {visibleIssues.map((issue) => (
                <IssuePill key={issue.id} issue={issue} />
              ))}
              {hiddenIssueCount > 0 ? (
                <Link
                  to={workspaceHref}
                  className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t("projectWorkspaceSummary.moreIssues", { count: hiddenIssueCount })}
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IssuePill({ issue }: { issue: Issue }) {
  return (
    <IssuesQuicklook issue={issue}>
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 font-mono text-xs text-foreground transition-colors hover:border-foreground/30 hover:text-foreground hover:underline"
      >
        {issue.identifier ?? issue.id.slice(0, 8)}
      </Link>
    </IssuesQuicklook>
  );
}
