import { t, useTranslation, i18n } from "@/i18n";
import { taskChatDurationLabel, taskChatEnumLabel } from "./task-chat-display";
import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, Loader2, Pause, Play, Pencil, Trash2 } from "lucide-react";
import type {
  RunnerGoalAction,
  RunnerGoalActionRequest,
  RunnerGoalProjection,
} from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { RunnerGoalComposerCommand } from "./TaskChatComposer";

const PENDING_LABELS: Record<string, string> = {
  starting: "status.starting",
  editing: "localizationProjects.ui_Saving",
  replacing: "localizationTaskExecution.replacing",
  pausing: "localizationTaskExecution.pausingTurn",
  resuming: "localizationTaskExecution.resuming",
  clearing: "localizationTaskExecution.clearing",
  continuing: "localizationTaskExecution.continuingRun",
};

function requestId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `goal_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return taskChatDurationLabel(`${seconds}s`);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return taskChatDurationLabel(`${minutes}m`);
  const hours = Math.floor(minutes / 60);
  return taskChatDurationLabel(`${hours}h ${minutes % 60}m`);
}

function formatTokens(tokens: number) {
  return new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, { notation: "compact", maximumFractionDigits: tokens >= 10_000 ? 0 : 1 }).format(tokens);
}

class LocalGoalActionError extends Error {
  constructor(readonly messageKey: string) {
    super(t(messageKey));
  }
}

export function useRunnerGoalControl(issueId: string | null, agentId: string | null) {
  useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<{
    action: "edit" | "replace";
    objective: string;
    revision: number;
  } | null>(null);
  const [actionFailure, setActionError] = useState<Error | null>(null);
  const actionError = actionFailure instanceof LocalGoalActionError
    ? t(actionFailure.messageKey)
    : actionFailure?.message ?? null;
  useEffect(() => {
    setExpanded(false);
    setDialog(null);
    setActionError(null);
  }, [issueId, agentId]);
  const key = queryKeys.issues.runnerGoal(issueId ?? "__none__", agentId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => issuesApi.getRunnerGoal(issueId!, agentId),
    enabled: Boolean(issueId),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    refetchInterval: (state) => state.state.data?.goal?.status === "active" ? 30_000 : false,
  });
  const mutation = useMutation({
    mutationFn: (request: RunnerGoalActionRequest) => issuesApi.actOnRunnerGoal(issueId!, request),
    onSuccess: (accepted) => {
      queryClient.setQueryData(key, accepted.projection);
      setExpanded(accepted.projection.goal != null);
    },
  });

  useCompanyLiveEvent((event) => {
    if (event.type !== "agent.session.goal.changed") return;
    const next = event.payload as unknown as RunnerGoalProjection;
    if (next.issueId !== issueId || (agentId && next.agentId !== agentId)) return;
    const current = queryClient.getQueryData<RunnerGoalProjection>(key);
    if (current && next.revision > current.revision + 1) {
      void query.refetch();
      return;
    }
    if (!current || next.revision >= current.revision) queryClient.setQueryData(key, next);
  });

  const executeAction = useCallback(async (
    action: RunnerGoalAction,
    objective?: string,
    confirmReplace = false,
    expectedRevision?: number,
  ) => {
    setActionError(null);
    try {
      const current = query.data ?? (await query.refetch()).data;
      if (!current?.agentId) {
        throw current?.capability.reason != null
          ? new Error(current.capability.reason)
          : new LocalGoalActionError("localizationTaskExecution.selectGoalAgent");
      }
      if (current.capability.availability !== "available") {
        throw current.capability.reason != null
          ? new Error(current.capability.reason)
          : new LocalGoalActionError("localizationTaskExecution.sessionGoalUnsupported");
      }
      await mutation.mutateAsync({
        requestId: requestId(),
        agentId: current.agentId,
        expectedRevision: expectedRevision ?? current.revision,
        action,
        ...(objective ? { objective } : {}),
        ...(action === "replace" ? { confirmReplace } : {}),
      });
    } catch (error) {
      setActionError(error instanceof Error ? error : new LocalGoalActionError("localizationTaskExecution.goalActionFailed"));
      throw error;
    }
  }, [mutation, query]);

  const edit = useCallback(async () => {
    const current = query.data ?? (await query.refetch()).data;
    if (!current?.goal) throw new Error(t("localizationTaskExecution.noGoalToEdit"));
    mutation.reset();
    setActionError(null);
    setExpanded(true);
    setDialog({ action: "edit", objective: current.goal.objective, revision: current.revision });
  }, [query, mutation]);

  const executeComposerCommand = useCallback(async (command: RunnerGoalComposerCommand) => {
    if (command.action === "focus") {
      const current = query.data ?? (await query.refetch()).data;
      if (!current?.goal && !current?.pendingAction) {
        throw new Error(t("localizationTaskExecution.goalObjectiveRequired"));
      }
      setExpanded(true);
      return;
    }
    if (command.action === "edit") {
      await edit();
      return;
    }
    if (command.action === "create") {
      const current = query.data ?? (await query.refetch()).data;
      const unfinished = current?.goal && current.goal.status !== "complete";
      if (unfinished) {
        mutation.reset();
        setActionError(null);
        setExpanded(true);
        setDialog({ action: "replace", objective: command.objective, revision: current.revision });
      } else {
        await executeAction("create", command.objective);
      }
      return;
    }
    await executeAction(command.action);
  }, [edit, executeAction, query, mutation]);

  const submitDialog = async () => {
    if (!dialog || mutation.isPending) return;
    const objective = dialog.objective.trim();
    if (!objective || objective.length > 4_000) return;
    try {
      await executeAction(dialog.action, objective, dialog.action === "replace", dialog.revision);
      setDialog(null);
    } catch {
      // Keep the objective and the inline error available for correction.
    }
  };

  return {
    ...query,
    expanded,
    setExpanded,
    dialog,
    setDialog,
    submitDialog,
    actionError,
    mutation,
    executeAction,
    edit,
    executeComposerCommand,
  };
}

export type RunnerGoalControl = ReturnType<typeof useRunnerGoalControl>;

export function RunnerGoalWidget({ control }: { control: RunnerGoalControl }) {
  const { t } = useTranslation();
  const projection = control.data;
  const goal = projection?.goal ?? null;
  const capability = projection?.capability;
  const can = (action: "set" | "pause" | "resume" | "clear") =>
    capability?.availability === "available" && capability.actions.includes(action);
  const resumable = goal && ["paused", "blocked", "limited", "usage_limited"].includes(goal.status);
  const pendingLabel = projection?.pendingAction ? t(PENDING_LABELS[projection.pendingAction]) : null;
  const mutationError = control.actionError ?? (control.mutation?.error instanceof Error
    ? control.mutation.error.message
    : control.mutation?.error
      ? t("localizationTaskExecution.goalActionFailed")
      : null);
  // Expansion controls the objective's detail, not whether an empty card exists.
  // In particular, a cleared goal must disappear even after it was expanded.
  if (!goal && !projection?.pendingAction && !control.dialog && !mutationError) return null;

  return (
    <section
      className="rounded-xl border border-border/80 bg-card/95 px-3 py-2 shadow-sm"
      aria-label={t("localizationTaskExecution.agentSessionGoal")}
      data-testid="runner-goal-widget"
    >
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold">{t("localizationTaskExecution.sessionGoal")}</span>
            {goal ? (
              <span className={cn("rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium", i18n.resolvedLanguage === "en" && "capitalize")} role="status">
                {t(`localizationTaskExecution.goalStatus.${goal.status}`, { defaultValue: taskChatEnumLabel(goal.status) })}
              </span>
            ) : null}
            {goal?.workingNow ? (
              <span className="inline-flex items-center gap-1 text-xs text-primary" role="status">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />{t("localizationTaskExecution.workingNow")}</span>
            ) : null}
            {pendingLabel ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> {pendingLabel}
              </span>
            ) : null}
          </div>
          {goal ? (
            <p className={cn("mt-1 text-sm leading-snug", control.expanded ? "max-h-40 overflow-auto" : "line-clamp-2")}>{goal.objective}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {capability?.reason ?? t("localizationTaskExecution.goalStartHelp")}
            </p>
          )}
          {goal ? (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{formatDuration(goal.elapsedSeconds)}</span>
              {capability?.usageReporting ? (
                <span>
                  {t("localizationTaskExecution.tokensUsed", { count: goal.tokensUsed, formattedCount: formatTokens(goal.tokensUsed) })}{goal.tokenBudget ? ` / ${formatTokens(goal.tokenBudget)}` : ""}
                </span>
              ) : null}
              {goal.iterations > 0 ? <span>{t("localizationTaskExecution.iterations", { count: goal.iterations })}</span> : null}
              {goal.lastReason ? <span className="truncate">{goal.lastReason}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {goal && can("set") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.edit().catch(() => {})} aria-label={t("localizationTaskExecution.editGoal")}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {goal?.status === "active" && can("pause") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.executeAction("pause").catch(() => {})} aria-label={t("localizationTaskExecution.pauseGoal")}>
              <Pause className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {resumable && can("resume") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.executeAction("resume").catch(() => {})} aria-label={t("localizationTaskExecution.resumeGoal")}>
              <Play className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {goal && can("clear") ? (
            <Button size="icon" variant="ghost" className={cn("h-7 w-7", "text-muted-foreground hover:text-destructive")} onClick={() => void control.executeAction("clear").catch(() => {})} aria-label={t("localizationTaskExecution.clearGoal")}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
      {mutationError ? (
        <p className="mt-1 text-xs text-destructive" role="alert">{mutationError}</p>
      ) : null}
      <Dialog open={Boolean(control.dialog)} onOpenChange={(open) => {
        if (!open && !control.mutation?.isPending) control.setDialog(null);
      }}>
        <DialogContent showCloseButton={!control.mutation?.isPending}>
          <form className="space-y-4" onSubmit={(event) => {
            event.preventDefault();
            void control.submitDialog();
          }}>
            <DialogHeader>
              <DialogTitle>{control.dialog?.action === "replace" ? t("localizationTaskExecution.replaceSessionGoal") : t("localizationTaskExecution.editSessionGoal")}</DialogTitle>
              <DialogDescription>
                {control.dialog?.action === "replace"
                  ? t("localizationTaskExecution.replaceGoalHelp")
                  : t("localizationTaskExecution.editGoalHelp")}
              </DialogDescription>
            </DialogHeader>
            <label className="block space-y-2">
              <span className="text-sm font-medium">{t("localizationTaskExecution.goalObjective")}</span>
              <Textarea
                value={control.dialog?.objective ?? ""}
                maxLength={4_000}
                required
                disabled={control.mutation?.isPending}
                onChange={(event) => {
                  const objective = event.target.value;
                  control.setDialog((current) => current ? { ...current, objective } : null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </label>
            {mutationError ? <p className="text-sm text-destructive" role="alert">{mutationError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={control.mutation?.isPending} onClick={() => control.setDialog(null)}>{t("localizationFilters.cancel")}</Button>
              <Button type="submit" disabled={!control.dialog?.objective.trim() || control.mutation?.isPending}>
                {control.mutation?.isPending ? t("localizationProjectRepositories.saving") : control.dialog?.action === "replace" ? t("localizationTaskExecution.replaceGoal") : t("localizationTaskExecution.saveGoal")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
