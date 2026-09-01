import { useCallback, useState } from "react";
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
import type { RunnerGoalComposerCommand } from "./TaskChatComposer";

const PENDING_LABELS: Record<string, string> = {
  starting: "Starting",
  editing: "Saving",
  replacing: "Replacing",
  pausing: "Pausing after current turn",
  resuming: "Resuming",
  clearing: "Clearing",
  continuing: "Continuing in a new run",
};

function requestId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `goal_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(tokens: number) {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}

export function useRunnerGoalControl(issueId: string | null, agentId: string | null) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
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
      setExpanded(true);
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
  ) => {
    const current = query.data ?? (await query.refetch()).data;
    if (!current?.agentId) throw new Error(current?.capability.reason ?? "Select an agent to use /goal.");
    if (current.capability.availability !== "available") {
      throw new Error(current.capability.reason ?? "Session goals are unsupported by this agent.");
    }
    await mutation.mutateAsync({
      requestId: requestId(),
      agentId: current.agentId,
      expectedRevision: current.revision,
      action,
      ...(objective ? { objective } : {}),
      ...(action === "replace" ? { confirmReplace } : {}),
    });
  }, [mutation, query]);

  const edit = useCallback(async () => {
    const current = query.data ?? (await query.refetch()).data;
    if (!current?.goal) throw new Error("There is no current session goal to edit.");
    const objective = window.prompt("Edit the session goal", current.goal.objective)?.trim();
    if (!objective || objective === current.goal.objective) return;
    await executeAction("edit", objective);
  }, [executeAction, query]);

  const executeComposerCommand = useCallback(async (command: RunnerGoalComposerCommand) => {
    if (command.action === "focus") {
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
        const confirmed = window.confirm("Replace the unfinished session goal with this new objective?");
        if (!confirmed) return;
        await executeAction("replace", command.objective, true);
      } else {
        await executeAction("create", command.objective);
      }
      return;
    }
    await executeAction(command.action);
  }, [edit, executeAction, query]);

  return {
    ...query,
    expanded,
    setExpanded,
    mutation,
    executeAction,
    edit,
    executeComposerCommand,
  };
}

export type RunnerGoalControl = ReturnType<typeof useRunnerGoalControl>;

export function RunnerGoalWidget({ control }: { control: RunnerGoalControl }) {
  const projection = control.data;
  const goal = projection?.goal ?? null;
  if (!control.expanded && !goal && !projection?.pendingAction) return null;

  const capability = projection?.capability;
  const can = (action: "set" | "pause" | "resume" | "clear") =>
    capability?.availability === "available" && capability.actions.includes(action);
  const resumable = goal && ["paused", "blocked", "limited", "usage_limited"].includes(goal.status);
  const pendingLabel = projection?.pendingAction ? PENDING_LABELS[projection.pendingAction] : null;
  const mutationError = control.mutation?.error instanceof Error
    ? control.mutation.error.message
    : control.mutation?.error
      ? "The goal action could not be applied."
      : null;

  return (
    <section
      className="rounded-xl border border-border/80 bg-card/95 px-3 py-2 shadow-sm"
      aria-label="Agent session goal"
      data-testid="runner-goal-widget"
    >
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold">Session goal</span>
            {goal ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium capitalize" role="status">
                {goal.status.replaceAll("_", " ")}
              </span>
            ) : null}
            {goal?.workingNow ? (
              <span className="inline-flex items-center gap-1 text-xs text-primary" role="status">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> Working now
              </span>
            ) : null}
            {pendingLabel ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> {pendingLabel}
              </span>
            ) : null}
          </div>
          {goal ? (
            <p className="mt-1 line-clamp-2 text-sm leading-snug">{goal.objective}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {capability?.reason ?? "Type /goal followed by an objective to pursue work across turns."}
            </p>
          )}
          {goal ? (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{formatDuration(goal.elapsedSeconds)}</span>
              {capability?.usageReporting ? (
                <span>
                  {formatTokens(goal.tokensUsed)} tokens
                  {goal.tokenBudget ? ` / ${formatTokens(goal.tokenBudget)}` : ""}
                </span>
              ) : null}
              {goal.iterations > 0 ? <span>{goal.iterations} iterations</span> : null}
              {goal.lastReason ? <span className="truncate">{goal.lastReason}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {goal && can("set") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.edit()} aria-label="Edit goal">
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {goal?.status === "active" && can("pause") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.executeAction("pause")} aria-label="Pause goal">
              <Pause className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {resumable && can("resume") ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void control.executeAction("resume")} aria-label="Resume goal">
              <Play className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          {goal && can("clear") ? (
            <Button size="icon" variant="ghost" className={cn("h-7 w-7", "text-muted-foreground hover:text-destructive")} onClick={() => void control.executeAction("clear")} aria-label="Clear goal">
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
      {mutationError ? (
        <p className="mt-1 text-xs text-destructive" role="alert">{mutationError}</p>
      ) : null}
    </section>
  );
}
