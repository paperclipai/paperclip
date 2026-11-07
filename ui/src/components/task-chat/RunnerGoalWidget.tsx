import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t, useTranslation } from "@/i18n";
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

function pendingLabels(): Record<string, string> {
  return {
    starting: t("issues.RunnerGoalWidget.pendingStarting"),
    editing: t("issues.RunnerGoalWidget.pendingEditing"),
    replacing: t("issues.RunnerGoalWidget.pendingReplacing"),
    pausing: t("issues.RunnerGoalWidget.pendingPausing"),
    resuming: t("issues.RunnerGoalWidget.pendingResuming"),
    clearing: t("issues.RunnerGoalWidget.pendingClearing"),
    continuing: t("issues.RunnerGoalWidget.pendingContinuing"),
  };
}

function goalStatusLabels(): Record<string, string> {
  return {
    active: t("issues.RunnerGoalWidget.statusActive"),
    blocked: t("issues.RunnerGoalWidget.statusBlocked"),
    budget_limited: t("issues.RunnerGoalWidget.statusBudgetLimited"),
    complete: t("issues.RunnerGoalWidget.statusComplete"),
    limited: t("issues.RunnerGoalWidget.statusLimited"),
    paused: t("issues.RunnerGoalWidget.statusPaused"),
    usage_limited: t("issues.RunnerGoalWidget.statusUsageLimited"),
  };
}

function requestId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `goal_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return t("issues.FormatDuration.seconds", { value: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("issues.FormatDuration.minutes", { value: minutes });
  const hours = Math.floor(minutes / 60);
  return t("issues.FormatDuration.hoursMinutes", { hours, minutes: minutes % 60 });
}

function formatTokens(tokens: number) {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}

export function useRunnerGoalControl(issueId: string | null, agentId: string | null) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<{
    action: "edit" | "replace";
    objective: string;
    revision: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
      if (!current?.agentId) throw new Error(current?.capability.reason ?? t("issues.UseRunnerGoalControl.selectAgentForGoal"));
      if (current.capability.availability !== "available") {
        throw new Error(current.capability.reason ?? t("issues.UseRunnerGoalControl.unsupportedGoals"));
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
      setActionError(error instanceof Error ? error.message : t("issues.UseRunnerGoalControl.actionFailed"));
      throw error;
    }
  }, [mutation, query, t]);

  const edit = useCallback(async () => {
    const current = query.data ?? (await query.refetch()).data;
    if (!current?.goal) throw new Error(t("issues.UseRunnerGoalControl.noGoalToEdit"));
    mutation.reset();
    setActionError(null);
    setExpanded(true);
    setDialog({ action: "edit", objective: current.goal.objective, revision: current.revision });
  }, [query, mutation, t]);

  const executeComposerCommand = useCallback(async (command: RunnerGoalComposerCommand) => {
    if (command.action === "focus") {
      const current = query.data ?? (await query.refetch()).data;
      if (!current?.goal && !current?.pendingAction) {
        throw new Error(t("issues.UseRunnerGoalControl.addObjective"));
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
  }, [edit, executeAction, query, mutation, t]);

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
  const pendingLabel = projection?.pendingAction ? pendingLabels()[projection.pendingAction] : null;
  const mutationError = control.actionError ?? (control.mutation?.error instanceof Error
    ? control.mutation.error.message
    : control.mutation?.error
      ? t("issues.UseRunnerGoalControl.actionFailed")
      : null);
  // Expansion controls the objective's detail, not whether an empty card exists.
  // In particular, a cleared goal must disappear even after it was expanded.
  if (!goal && !projection?.pendingAction && !control.dialog && !mutationError) return null;

  return (
    <section
      className="rounded-xl border border-border/80 bg-card/95 px-3 py-2 shadow-sm"
      aria-label={t("issues.RunnerGoalWidget.sessionGoalRegion")}
      data-testid="runner-goal-widget"
    >
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold">{t("issues.RunnerGoalWidget.sessionGoal")}</span>
            {goal ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium capitalize" role="status">
                {goalStatusLabels()[goal.status] ?? goal.status.replaceAll("_", " ")}
              </span>
            ) : null}
            {goal?.workingNow ? (
              <span className="inline-flex items-center gap-1 text-xs text-primary" role="status">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> {t("issues.RunnerGoalWidget.workingNow")}
              </span>
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
              {capability?.reason ?? t("issues.RunnerGoalWidget.typeGoalHint")}
            </p>
          )}
          {goal ? (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{formatDuration(goal.elapsedSeconds)}</span>
              {capability?.usageReporting ? (
                <span>
                  {goal.tokenBudget
                    ? t("issues.RunnerGoalWidget.tokensWithBudget", { used: formatTokens(goal.tokensUsed), budget: formatTokens(goal.tokenBudget) })
                    : t("issues.RunnerGoalWidget.tokensUsed", { used: formatTokens(goal.tokensUsed) })}
                </span>
              ) : null}
              {goal.iterations > 0 ? <span>{t("issues.RunnerGoalWidget.iterations", { count: goal.iterations })}</span> : null}
              {goal.lastReason ? <span className="truncate">{goal.lastReason}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {goal && can("set") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.edit().catch(() => {})} aria-label={t("issues.RunnerGoalWidget.editGoal")}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {goal?.status === "active" && can("pause") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.executeAction("pause").catch(() => {})} aria-label={t("issues.RunnerGoalWidget.pauseGoal")}>
              <Pause className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {resumable && can("resume") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.executeAction("resume").catch(() => {})} aria-label={t("issues.RunnerGoalWidget.resumeGoal")}>
              <Play className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {goal && can("clear") ? (
            <Button size="icon" variant="ghost" className={cn("h-7 w-7", "text-muted-foreground hover:text-destructive")} onClick={() => void control.executeAction("clear").catch(() => {})} aria-label={t("issues.RunnerGoalWidget.clearGoal")}>
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
              <DialogTitle>{control.dialog?.action === "replace" ? t("issues.RunnerGoalWidget.replaceTitle") : t("issues.RunnerGoalWidget.editTitle")}</DialogTitle>
              <DialogDescription>
                {control.dialog?.action === "replace"
                  ? t("issues.RunnerGoalWidget.replaceDescription")
                  : t("issues.RunnerGoalWidget.editDescription")}
              </DialogDescription>
            </DialogHeader>
            <label className="block space-y-2">
              <span className="text-sm font-medium">{t("issues.RunnerGoalWidget.goalObjective")}</span>
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
              <Button type="button" variant="outline" disabled={control.mutation?.isPending} onClick={() => control.setDialog(null)}>{t("issues.RunnerGoalWidget.cancel")}</Button>
              <Button type="submit" disabled={!control.dialog?.objective.trim() || control.mutation?.isPending}>
                {control.mutation?.isPending ? t("issues.RunnerGoalWidget.saving") : control.dialog?.action === "replace" ? t("issues.RunnerGoalWidget.replaceGoal") : t("issues.RunnerGoalWidget.saveGoal")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
