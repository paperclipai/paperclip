import { Link } from "@/lib/router";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { CopyText } from "./CopyText";
import { IssuesQuicklook } from "./IssuesQuicklook";
import type { ProjectWorkspaceLinkedIssue, ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { useManagedSandboxOnly } from "../hooks/useManagedSandboxOnly";
import { cn, projectWorkspaceUrl, relativeTime } from "../lib/utils";
import { Copy, ExternalLink, FolderOpen, GitBranch, Loader2, Play, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/i18n";

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
  const { t } = useTranslation();
  const { hideHostPaths } = useManagedSandboxOnly();
  const visibleIssues = summary.issues.slice(0, 4);
  const hiddenIssueCount = Math.max(summary.linkedIssueCount - visibleIssues.length, 0);
  const workspaceHref =
    summary.kind === "project_workspace"
      ? projectWorkspaceUrl({ id: projectRef, urlKey: projectRef }, summary.workspaceId)
      : `/execution-workspaces/${summary.workspaceId}`;
  const hasRunningServices = summary.runningServiceCount > 0;
  const actionKey = `${summary.key}:${hasRunningServices ? "stop" : "start"}`;

  return (
    <div className="rounded-lg border border-border bg-background p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="border-border bg-background px-2.5 py-1 text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                {summary.kind === "execution_workspace"
                  ? t("workspaces.types.execution")
                  : t("workspaces.types.project")}
              </Badge>
              <Badge variant="outline" className="border-border/70 bg-background px-2.5 py-1 text-muted-foreground">
                {t("workspaces.summary.updated", { time: relativeTime(summary.lastUpdatedAt) })}
              </Badge>
              {summary.serviceCount > 0 ? (
                <Badge variant="outline"
                  className={cn(
                    "gap-1.5 px-2.5 py-1",
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
                  {t("workspaces.summary.services", {
                    running: summary.runningServiceCount,
                    total: summary.serviceCount,
                  })}
                </Badge>
              ) : null}
              {summary.executionWorkspaceStatus ? (
                <Badge variant="outline" className="border-border/70 bg-background px-2.5 py-1 text-muted-foreground">
                  {t(`workspaces.status.${summary.executionWorkspaceStatus}`, {
                    defaultValue: summary.executionWorkspaceStatus.replace(/_/g, " "),
                  })}
                </Badge>
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
                {hasRunningServices
                  ? t("workspaces.runtime.stopServices")
                  : t("workspaces.runtime.startServices")}
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
                  ? t("workspaces.close.retry")
                  : t("workspaces.close.action")}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-border/70 bg-background px-3 py-3">
          <div className="space-y-2 text-sm">
            {summary.branchName ? (
              <div className="flex items-start gap-2">
                <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    {t("workspaces.fields.branch")}
                  </div>
                  <div className="flex items-start gap-2">
                    <CopyText
                      text={summary.branchName}
                      containerClassName="min-w-0"
                      className="min-w-0 break-all text-left font-mono text-xs text-foreground"
                      copiedLabel={t("workspaces.copy.branchCopied")}
                    >
                      {summary.branchName}
                    </CopyText>
                    <CopyText
                      text={summary.branchName}
                      ariaLabel={t("workspaces.copy.branch")}
                      className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                      copiedLabel={t("workspaces.copy.branchCopied")}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </div>
                </div>
              </div>
            ) : null}

            {/*
              The path is a host filesystem path, so it disappears under the
              managed-sandbox-only policy, and stays hidden until that policy is
              known. Branch, service, and issue rows stay.
            */}
            {summary.cwd && !hideHostPaths ? (
              <div className="flex items-start gap-2">
                <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    {t("workspaces.fields.path")}
                  </div>
                  <div className="flex items-start gap-2">
                    <CopyText
                      text={summary.cwd}
                      title={summary.cwd}
                      containerClassName="min-w-0"
                      className="min-w-0 break-all text-left font-mono text-xs text-foreground"
                      copiedLabel={t("workspaces.copy.pathCopied")}
                    >
                      {truncatePath(summary.cwd)}
                    </CopyText>
                    <CopyText
                      text={summary.cwd}
                      ariaLabel={t("workspaces.copy.path")}
                      className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                      copiedLabel={t("workspaces.copy.pathCopied")}
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
                  <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    {t("workspaces.fields.service")}
                  </div>
                  <a
                    href={summary.primaryServiceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      "break-all font-mono text-xs hover:underline",
                      summary.primaryServiceUrlRunning
                        ? "text-emerald-700 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200"
                        : "text-foreground",
                    )}
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
            <div className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
              {t("workspaces.summary.linkedTasks")}
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
                  {t("workspaces.summary.moreTasks", { count: hiddenIssueCount })}
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IssuePill({ issue }: { issue: ProjectWorkspaceLinkedIssue }) {
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
