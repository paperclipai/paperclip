import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { Loader2 } from "lucide-react";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, issueUrl } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type ExecutionWorkspaceCloseDialogProps = {
  workspaceId: string;
  workspaceName: string;
  currentStatus: ExecutionWorkspace["status"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed?: (workspace: ExecutionWorkspace) => void;
};

function readinessTone(state: "ready" | "ready_with_warnings" | "blocked") {
  if (state === "blocked") {
    return "border-destructive/30 bg-destructive/5 text-destructive";
  }
  if (state === "ready_with_warnings") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

export function ExecutionWorkspaceCloseDialog({
  workspaceId,
  workspaceName,
  currentStatus,
  open,
  onOpenChange,
  onClosed,
}: ExecutionWorkspaceCloseDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const actionLabel =
    currentStatus === "cleanup_failed"
      ? t("components.executionWorkspaceCloseDialog.retryClose", { defaultValue: "Retry close" })
      : t("components.executionWorkspaceCloseDialog.closeWorkspace", { defaultValue: "Close workspace" });

  const readinessQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.closeReadiness(workspaceId),
    queryFn: () => executionWorkspacesApi.getCloseReadiness(workspaceId),
    enabled: open,
  });

  const closeWorkspace = useMutation({
    mutationFn: () => executionWorkspacesApi.update(workspaceId, { status: "archived" }),
    onSuccess: (workspace) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(workspace.id), workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(workspace.id) });
      pushToast({
        title:
          currentStatus === "cleanup_failed"
            ? t("components.executionWorkspaceCloseDialog.workspaceCloseRetried", {
                defaultValue: "Workspace close retried",
              })
            : t("components.executionWorkspaceCloseDialog.workspaceClosed", { defaultValue: "Workspace closed" }),
        tone: "success",
      });
      onOpenChange(false);
      onClosed?.(workspace);
    },
    onError: (error) => {
      pushToast({
        title: t("components.executionWorkspaceCloseDialog.failedToCloseWorkspace", {
          defaultValue: "Failed to close workspace",
        }),
        body:
          error instanceof Error
            ? error.message
            : t("components.executionWorkspaceCloseDialog.unknownError", { defaultValue: "Unknown error" }),
        tone: "error",
      });
    },
  });

  const readiness = readinessQuery.data ?? null;
  const blockingIssues = readiness?.linkedIssues.filter((issue) => !issue.isTerminal) ?? [];
  const otherLinkedIssues = readiness?.linkedIssues.filter((issue) => issue.isTerminal) ?? [];
  const confirmDisabled =
    currentStatus === "archived" ||
    closeWorkspace.isPending ||
    readinessQuery.isLoading ||
    readiness == null ||
    readiness.state === "blocked";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!closeWorkspace.isPending) onOpenChange(nextOpen);
    }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription className="break-words">
            {t("components.executionWorkspaceCloseDialog.dialogDescriptionPrefix", { defaultValue: "Archive " })}
            <span className="font-medium text-foreground">{workspaceName}</span>
            {t("components.executionWorkspaceCloseDialog.dialogDescriptionSuffix", {
              defaultValue:
                " and clean up any owned workspace artifacts. Paperclip keeps the workspace record and task history, but removes it from active workspace views.",
            })}
          </DialogDescription>
        </DialogHeader>

        {readinessQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("components.executionWorkspaceCloseDialog.checkingSafeToClose", {
              defaultValue: "Checking whether this workspace is safe to close...",
            })}
          </div>
        ) : readinessQuery.error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {readinessQuery.error instanceof Error
              ? readinessQuery.error.message
              : t("components.executionWorkspaceCloseDialog.failedToInspectReadiness", {
                  defaultValue: "Failed to inspect workspace close readiness.",
                })}
          </div>
        ) : readiness ? (
          <div className="space-y-4">
            <div className={`rounded-xl border px-4 py-3 text-sm ${readinessTone(readiness.state)}`}>
              <div className="font-medium">
                {readiness.state === "blocked"
                  ? t("components.executionWorkspaceCloseDialog.closeIsBlocked", { defaultValue: "Close is blocked" })
                  : readiness.state === "ready_with_warnings"
                    ? t("components.executionWorkspaceCloseDialog.closeAllowedWithWarnings", {
                        defaultValue: "Close is allowed with warnings",
                      })
                    : t("components.executionWorkspaceCloseDialog.closeIsReady", { defaultValue: "Close is ready" })}
              </div>
              <div className="mt-1 text-xs opacity-80">
                {readiness.isSharedWorkspace
                  ? t("components.executionWorkspaceCloseDialog.sharedWorkspaceNote", {
                      defaultValue:
                        "This is a shared workspace session. Archiving it removes this session record but keeps the underlying project workspace.",
                    })
                  : readiness.git?.workspacePath && readiness.git.repoRoot && readiness.git.workspacePath !== readiness.git.repoRoot
                    ? t("components.executionWorkspaceCloseDialog.ownCheckoutNote", {
                        defaultValue:
                          "This execution workspace has its own checkout path and can be archived independently.",
                      })
                    : readiness.isProjectPrimaryWorkspace
                      ? t("components.executionWorkspaceCloseDialog.primaryWorkspaceNote", {
                          defaultValue:
                            "This execution workspace currently points at the project's primary workspace path.",
                        })
                      : t("components.executionWorkspaceCloseDialog.disposableWorkspaceNote", {
                          defaultValue: "This workspace is disposable and can be archived.",
                        })}
              </div>
            </div>

            {blockingIssues.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">
                  {t("components.executionWorkspaceCloseDialog.blockingTasks", { defaultValue: "Blocking tasks" })}
                </h3>
                <div className="space-y-2">
                  {blockingIssues.map((issue) => (
                    <div key={issue.id} className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <Link to={issueUrl(issue)} className="min-w-0 break-words font-medium hover:underline">
                          {issue.identifier ?? issue.id} · {issue.title}
                        </Link>
                        <span className="text-xs text-muted-foreground">{issue.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {readiness.blockingReasons.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">
                  {t("components.executionWorkspaceCloseDialog.blockingReasons", { defaultValue: "Blocking reasons" })}
                </h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.blockingReasons.map((reason) => (
                    <li key={reason} className="break-words rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive">
                      {reason}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readiness.warnings.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">
                  {t("components.executionWorkspaceCloseDialog.warnings", { defaultValue: "Warnings" })}
                </h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.warnings.map((warning) => (
                    <li key={warning} className="break-words rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                      {warning}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readiness.git ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">
                  {t("components.executionWorkspaceCloseDialog.gitStatus", { defaultValue: "Git status" })}
                </h3>
                <div className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        {t("components.executionWorkspaceCloseDialog.gitBranch", { defaultValue: "Branch" })}
                      </div>
                      <div className="font-mono text-xs">
                        {readiness.git.branchName ??
                          t("components.executionWorkspaceCloseDialog.unknown", { defaultValue: "Unknown" })}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        {t("components.executionWorkspaceCloseDialog.gitBaseRef", { defaultValue: "Base ref" })}
                      </div>
                      <div className="font-mono text-xs">
                        {readiness.git.baseRef ??
                          t("components.executionWorkspaceCloseDialog.notSet", { defaultValue: "Not set" })}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        {t("components.executionWorkspaceCloseDialog.gitMergedIntoBase", {
                          defaultValue: "Merged into base",
                        })}
                      </div>
                      <div>
                        {readiness.git.isMergedIntoBase == null
                          ? t("components.executionWorkspaceCloseDialog.unknown", { defaultValue: "Unknown" })
                          : readiness.git.isMergedIntoBase
                            ? t("components.executionWorkspaceCloseDialog.yes", { defaultValue: "Yes" })
                            : t("components.executionWorkspaceCloseDialog.no", { defaultValue: "No" })}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        {t("components.executionWorkspaceCloseDialog.gitAheadBehind", { defaultValue: "Ahead / behind" })}
                      </div>
                      <div>
                        {(readiness.git.aheadCount ?? 0).toString()} / {(readiness.git.behindCount ?? 0).toString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        {t("components.executionWorkspaceCloseDialog.gitDirtyTrackedFiles", {
                          defaultValue: "Dirty tracked files",
                        })}
                      </div>
                      <div>{readiness.git.dirtyEntryCount}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        {t("components.executionWorkspaceCloseDialog.gitUntrackedFiles", {
                          defaultValue: "Untracked files",
                        })}
                      </div>
                      <div>{readiness.git.untrackedEntryCount}</div>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {otherLinkedIssues.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">
                  {t("components.executionWorkspaceCloseDialog.otherLinkedTasks", {
                    defaultValue: "Other linked tasks",
                  })}
                </h3>
                <div className="space-y-2">
                  {otherLinkedIssues.map((issue) => (
                    <div key={issue.id} className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <Link to={issueUrl(issue)} className="min-w-0 break-words font-medium hover:underline">
                          {issue.identifier ?? issue.id} · {issue.title}
                        </Link>
                        <span className="text-xs text-muted-foreground">{issue.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {readiness.runtimeServices.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">
                  {t("components.executionWorkspaceCloseDialog.attachedRuntimeServices", {
                    defaultValue: "Attached runtime services",
                  })}
                </h3>
                <div className="space-y-2">
                  {readiness.runtimeServices.map((service) => (
                    <div key={service.id} className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{service.serviceName}</span>
                        <span className="text-xs text-muted-foreground">{service.status} · {service.lifecycle}</span>
                      </div>
                      <div className="mt-1 break-words text-xs text-muted-foreground">
                        {service.url ??
                          service.command ??
                          service.cwd ??
                          t("components.executionWorkspaceCloseDialog.noAdditionalDetails", {
                            defaultValue: "No additional details",
                          })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="space-y-2">
              <h3 className="text-sm font-medium">
                {t("components.executionWorkspaceCloseDialog.cleanupActions", { defaultValue: "Cleanup actions" })}
              </h3>
              <div className="space-y-2">
                {readiness.plannedActions.map((action, index) => (
                  <div key={`${action.kind}-${index}`} className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                    <div className="font-medium">{action.label}</div>
                    <div className="mt-1 break-words text-muted-foreground">{action.description}</div>
                    {action.command ? (
                      <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-background px-3 py-2 font-mono text-xs text-foreground">
                        {action.command}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            {currentStatus === "cleanup_failed" ? (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
                {t("components.executionWorkspaceCloseDialog.cleanupPreviouslyFailed", {
                  defaultValue:
                    "Cleanup previously failed on this workspace. Retrying close will rerun the cleanup flow and update the workspace status if it succeeds.",
                })}
              </div>
            ) : null}

            {currentStatus === "archived" ? (
              <div className="rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                {t("components.executionWorkspaceCloseDialog.alreadyArchived", {
                  defaultValue: "This workspace is already archived.",
                })}
              </div>
            ) : null}

            {readiness.git?.repoRoot ? (
              <div className="break-words text-xs text-muted-foreground">
                {t("components.executionWorkspaceCloseDialog.repoRootLabel", { defaultValue: "Repo root: " })}
                <span className="font-mono break-all">{readiness.git.repoRoot}</span>
                {readiness.git.workspacePath ? (
                  <>
                    {t("components.executionWorkspaceCloseDialog.workspacePathLabel", {
                      defaultValue: " · Workspace path: ",
                    })}
                    <span className="font-mono break-all">{readiness.git.workspacePath}</span>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="text-xs text-muted-foreground">
              {t("components.executionWorkspaceCloseDialog.lastChecked", {
                time: formatDateTime(new Date()),
                defaultValue: "Last checked {{time}}",
              })}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={closeWorkspace.isPending}
          >
            {t("components.executionWorkspaceCloseDialog.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            variant={currentStatus === "cleanup_failed" ? "default" : "destructive"}
            onClick={() => closeWorkspace.mutate()}
            disabled={confirmDisabled}
          >
            {closeWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
