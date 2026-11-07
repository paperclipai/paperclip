import { i18n, t, useTranslation, Trans } from "@/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace, ExecutionWorkspaceCloseReasonPresentation } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Loader2 } from "lucide-react";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { describeError } from "../api/errors";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, issueUrl } from "../lib/utils";
import { Button } from "./ui/button";
import { QueryErrorState, useQueryView } from "./QueryView";
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

function closeReason(raw: string, presentation?: ExecutionWorkspaceCloseReasonPresentation) {
  // English remains byte-compatible. Only a producer-supplied code opts a sentence in.
  if (i18n.resolvedLanguage === "en" || !presentation) return raw;
  const key = `integration-workspace-close:reason_${presentation.code}`;
  if (!i18n.exists(key, presentation.params as { count?: number })) return raw;
  return t(key, { ...presentation.params, baseRef: presentation.params?.baseRef ?? t("integration-workspace-close:base_ref"), defaultValue: raw });
}

function isKnownCloseVariant(kind: string, variant: string) {
  return (kind === "cleanup_command" && (variant === "workspace_cleanup" || variant === "project_workspace_cleanup"))
    || (kind === "remove_provider_workspace" && (variant === "plugin_storage_removal" || variant === "remote_compute_release"));
}

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
  useTranslation("task-components");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const actionLabel = currentStatus === "cleanup_failed" ? t("task-components:retryClose_46dde379") : t("task-components:closeWorkspace_e5086f04");

  const readinessQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.closeReadiness(workspaceId),
    queryFn: () => executionWorkspacesApi.getCloseReadiness(workspaceId),
    enabled: open,
  });
  // Read close readiness through the shared view: cached readiness stays
  // usable during a transient refetch failure,and a no-data failure shows
  // readable copy with Retry.
  const readinessView = useQueryView(readinessQuery);

  const closeWorkspace = useMutation({
    mutationFn: () => executionWorkspacesApi.update(workspaceId, { status: "archived" }),
    onSuccess: (workspace) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(workspace.id), workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.overview(workspace.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(workspace.id) });
      pushToast({ presentation: { title: currentStatus === "cleanup_failed" ? { key: "final-components-a:workspaceCloseRetried_6578b1b0" } : { key: "final-components-a:workspaceClosed_4d4984da" } }, 
        title: currentStatus === "cleanup_failed" ? t("final-components-a:workspaceCloseRetried_6578b1b0") : t("final-components-a:workspaceClosed_4d4984da"),
        tone: "success",
      });
      onOpenChange(false);
      onClosed?.(workspace);
    },
    onError: (error) => {
      pushToast({ presentation: { title: { key: "task-components:failedToCloseWorkspace_8e5f6a8f" } }, 
        title: t("task-components:failedToCloseWorkspace_8e5f6a8f"),
        body: describeError(error).body,
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
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription className="break-words"><Trans ns="task-components" i18nKey="sentence_3ab08d441993" components={{ part1: <>{<span className="font-medium text-foreground">{workspaceName}</span>}</> }} /></DialogDescription>
        </DialogHeader>

        {(readinessView.kind === "loading" || readinessView.kind === "reconnecting") ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />{t("task-components:checkingWhetherThisWorkspaceIsSafeTo_cb92922b")}</div>
        ) : readinessView.kind === "error" ? (
          <QueryErrorState
            error={readinessView.error}
            action="inspect workspace close readiness"
            onRetry={readinessView.retry}
            retrying={readinessView.isFetching}
          />
        ) : readiness ? (
          <div className="space-y-4">
            <div className={`rounded-xl border px-4 py-3 text-sm ${readinessTone(readiness.state)}`}>
              <div className="font-medium">
                {readiness.state === "blocked"
                  ? t("task-components:closeIsBlocked_45c83954")
                  : readiness.state === "ready_with_warnings"
                    ? t("task-components:closeIsAllowedWithWarnings_b1c701c3")
                    : t("task-components:closeIsReady_03f38b26")}
              </div>
              <div className="mt-1 text-xs opacity-80">
                {readiness.isSharedWorkspace
                  ? t("task-components:thisIsASharedWorkspaceSessionArchiving_faa246e6")
                  : readiness.git?.workspacePath && readiness.git.repoRoot && readiness.git.workspacePath !== readiness.git.repoRoot
                    ? t("task-components:thisExecutionWorkspaceHasItsOwnCheckout_22a46f33")
                    : readiness.isProjectPrimaryWorkspace
                      ? t("task-components:thisExecutionWorkspaceCurrentlyPointsAtThe_c8c33be7")
                      : t("task-components:thisWorkspaceIsDisposableAndCanBe_b8cc064e")}
              </div>
            </div>

            {blockingIssues.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("task-components:blockingTasks_aae9f305")}</h3>
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
                <h3 className="text-sm font-medium">{t("task-components:blockingReasons_fa594e19")}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.blockingReasons.map((reason, index) => (
                    <li key={index} className="break-words rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive">
                      {closeReason(reason, readiness.presentation?.blockingReasons[index])}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readiness.warnings.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("task-components:warnings_0e04cd10")}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.warnings.map((warning, index) => (
                    <li key={index} className="break-words rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                      {closeReason(warning, readiness.presentation?.warnings[index])}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readiness.git ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("task-components:gitStatus_591239c6")}</h3>
                <div className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:branch_52656e81")}</div>
                      <div className="font-mono text-xs">{readiness.git.branchName ?? t("task-components:unknown_b764cdc0")}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:baseRef_9c6c10f9")}</div>
                      <div className="font-mono text-xs">{readiness.git.baseRef ?? t("task-components:notSet_4895f731")}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:mergedIntoBase_82d48cbd")}</div>
                      <div>{readiness.git.isMergedIntoBase == null ? t("task-components:unknown_b764cdc0") : readiness.git.isMergedIntoBase ? t("task-components:yes_85a39ab3") : t("task-components:no_1ea442a1")}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:aheadBehind_3f89fb27")}</div>
                      <div>
                        {(readiness.git.aheadCount ?? 0).toString()} / {(readiness.git.behindCount ?? 0).toString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:dirtyTrackedFiles_73ba934e")}</div>
                      <div>{readiness.git.dirtyEntryCount}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:untrackedFiles_be1f1a6c")}</div>
                      <div>{readiness.git.untrackedEntryCount}</div>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {otherLinkedIssues.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("task-components:otherLinkedTasks_bf52ec29")}</h3>
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
                <h3 className="text-sm font-medium">{t("task-components:attachedRuntimeServices_51e1d884")}</h3>
                <div className="space-y-2">
                  {readiness.runtimeServices.map((service) => (
                    <div key={service.id} className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{service.serviceName}</span>
                        <span className="text-xs text-muted-foreground">{service.status} · {service.lifecycle}</span>
                      </div>
                      {/*
                        The last fallback used to print the service working
                        directory, a path on the execution host. The dialog has
                        no instance-policy context of its own, so it drops the
                        path outright and falls back to a neutral line.
                      */}
                      <div className="mt-1 break-words text-xs text-muted-foreground">
                        {service.url ?? service.command ?? t("task-components:noAdditionalDetails_f3109479")}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("task-components:cleanupActions_fc44694f")}</h3>
              <div className="space-y-2">
                {readiness.plannedActions.map((action, index) => (
                  <div key={`${action.kind}-${index}`} className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                    <div className="font-medium">{action.presentation && isKnownCloseVariant(action.kind, action.presentation.variant)
                      ? t(`integration-workspace-close:action_${action.presentation.variant}_label`, { defaultValue: action.label })
                      : t(`final-components-a:closeAction_${action.kind}_label`, { defaultValue: action.label, count: readiness.runtimeServices.length })}</div>
                    <div className="mt-1 break-words text-muted-foreground">{action.presentation && isKnownCloseVariant(action.kind, action.presentation.variant)
                      ? t(`integration-workspace-close:action_${action.presentation.variant}_description`, { defaultValue: action.description })
                      : t(`final-components-a:closeAction_${action.kind}_description`, { defaultValue: action.description, path: readiness.git?.workspacePath ?? "", count: readiness.runtimeServices.length, name: readiness.runtimeServices[0]?.serviceName ?? t("final-components-a:runtimeServiceFallback") })}</div>
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
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">{t("task-components:cleanupPreviouslyFailedOnThisWorkspaceRetrying_fbb99b6b")}</div>
            ) : null}

            {currentStatus === "archived" ? (
              <div className="rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">{t("task-components:thisWorkspaceIsAlreadyArchived_bb335e88")}</div>
            ) : null}

            {readiness.git?.repoRoot ? (
              <div className="break-words text-xs text-muted-foreground">{t("task-components:repoRoot_72decaf8")}<span className="font-mono break-all">{readiness.git.repoRoot}</span>
                {readiness.git.workspacePath ? (
                  <><Trans ns="task-components" i18nKey="sentence_05bd43c0e84a" components={{ part1: <>{<span className="font-mono break-all">{readiness.git.workspacePath}</span>}</> }} /></>
                ) : null}
              </div>
            ) : null}

            <div className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_ee5fbadbf54b" components={{ part1: <>{formatDateTime(new Date(readinessQuery.dataUpdatedAt))}</> }} /></div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={closeWorkspace.isPending}
          >{t("task-components:cancel_19766ed6")}</Button>
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
