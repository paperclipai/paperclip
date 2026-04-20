import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pause, Play, Power } from "lucide-react";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type PopupSide = "left" | "right";

function plural(count: number, singular: string, pluralText = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralText}`;
}

function isAuthzError(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function InstanceAgentPauseControl({ side = "right" }: { side?: PopupSide }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const pauseStateQuery = useQuery({
    queryKey: queryKeys.instance.agentPauseState,
    queryFn: () => agentsApi.instancePauseState(),
    refetchInterval: 15_000,
    retry: (failureCount, error) => !isAuthzError(error) && failureCount < 2,
  });

  const invalidateAgentPauseViews = async (companyIds: string[]) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.agentPauseState }),
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.agentServiceHealth }),
      queryClient.invalidateQueries({ queryKey: ["agents"] }),
      ...companyIds.flatMap((companyId) => [
        queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId) }),
      ]),
    ]);
  };

  const pauseAllMutation = useMutation({
    mutationFn: () => agentsApi.pauseAllInstanceAgents(),
    onSuccess: async (result) => {
      await invalidateAgentPauseViews(result.affectedCompanyIds);
      pushToast({
        title: result.pausedAgents > 0 ? "Agents paused" : "No runnable agents",
        body: result.pausedAgents > 0
          ? `${plural(result.pausedAgents, "agent")} paused for token availability.${result.cancelledRuns > 0 ? ` Cancelled ${plural(result.cancelledRuns, "active run")}.` : ""}`
          : "There were no runnable agents to pause.",
        tone: result.pausedAgents > 0 ? "success" : "info",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Pause failed",
        body: error instanceof Error ? error.message : "Could not pause agents.",
        tone: "error",
      });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => agentsApi.resumeTokenPausedInstanceAgents(),
    onSuccess: async (result) => {
      await invalidateAgentPauseViews(result.affectedCompanyIds);
      pushToast({
        title: result.resumedAgents > 0 ? "Agents resumed" : "No token-paused agents",
        body: result.resumedAgents > 0
          ? `${plural(result.resumedAgents, "agent")} paused by the token switch resumed. Manual and budget pauses were preserved.`
          : "There were no globally token-paused agents to resume.",
        tone: result.resumedAgents > 0 ? "success" : "info",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Resume failed",
        body: error instanceof Error ? error.message : "Could not resume agents.",
        tone: "error",
      });
    },
  });

  if (pauseStateQuery.error && isAuthzError(pauseStateQuery.error)) {
    return null;
  }

  const counts = pauseStateQuery.data?.counts;
  const isBusy = pauseAllMutation.isPending || resumeMutation.isPending;
  const isLoading = pauseStateQuery.isLoading && !counts;
  const loadError = pauseStateQuery.error && !isAuthzError(pauseStateQuery.error)
    ? pauseStateQuery.error
    : null;
  const tokenPausedAgents = counts?.tokenPausedAgents ?? 0;
  const runnableAgents = counts?.runnableAgents ?? 0;
  const activeRunCount = counts?.activeRunCount ?? 0;
  const scopedCompanyCount = counts?.scopedCompanyCount ?? 0;
  const hasTokenPausedAgents = tokenPausedAgents > 0;
  const triggerLabel = loadError
    ? "Agent token switch unavailable"
    : hasTokenPausedAgents
      ? `${plural(tokenPausedAgents, "agent")} paused for tokens`
      : "Agent token switch";

  function confirmPauseAll() {
    const runText = activeRunCount > 0 ? ` and cancel ${plural(activeRunCount, "queued/running run")}` : "";
    const companyText = scopedCompanyCount > 0 ? ` across ${plural(scopedCompanyCount, "company", "companies")}` : "";
    if (!window.confirm(
      `Pause ${plural(runnableAgents, "runnable agent")}${runText}${companyText}? Manual and budget pauses will be preserved.`,
    )) {
      return;
    }
    pauseAllMutation.mutate();
  }

  function confirmResume() {
    if (!window.confirm(
      `Resume ${plural(tokenPausedAgents, "agent")} paused by the token switch? Manual and budget-paused agents will stay paused.`,
    )) {
      return;
    }
    resumeMutation.mutate();
  }

  const trigger = (
    <button
      type="button"
      disabled={isBusy || isLoading || Boolean(loadError)}
      className={cn(
        "relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color] duration-150 hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        hasTokenPausedAgents && "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300",
      )}
      aria-label="Agent token switch"
      title={triggerLabel}
    >
      {isBusy || isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Power className="h-4 w-4" aria-hidden="true" />
      )}
      {hasTokenPausedAgents && (
        <span
          className="pointer-events-none absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-background"
          aria-hidden="true"
        />
      )}
    </button>
  );

  if (loadError) {
    return (
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={8}>
          <p>{loadError instanceof Error ? loadError.message : "Agent token switch unavailable"}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={8}>
          <p>{triggerLabel}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side={side} align="start" sideOffset={8} className="w-64">
        <DropdownMenuLabel>Agent token switch</DropdownMenuLabel>
        <div className="px-2 py-1 text-xs text-muted-foreground">
          {runnableAgents} runnable · {tokenPausedAgents} token-paused · {activeRunCount} queued/running
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={isBusy || runnableAgents === 0}
          onSelect={(event) => {
            event.preventDefault();
            confirmPauseAll();
          }}
        >
          <Pause className="h-4 w-4" />
          Pause all agents
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={isBusy || tokenPausedAgents === 0}
          onSelect={(event) => {
            event.preventDefault();
            confirmResume();
          }}
        >
          <Play className="h-4 w-4" />
          Resume token-paused agents
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
