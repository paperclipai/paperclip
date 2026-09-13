import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, CircleDot, CircleStop } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { heartbeatsApi, type LiveRunForIssue } from "../../api/heartbeats";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";

type StopPickerMode = "agent" | "task" | null;

interface AgentWithLiveRuns {
  agentId: string;
  agentName: string;
  runIds: string[];
}

interface PendingStop {
  title: string;
  description: string;
  runIds: string[];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function useLiveRuns(companyId: string | null | undefined, open: boolean) {
  const { data: liveRuns = [] } = useQuery({
    queryKey: queryKeys.liveRuns(companyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: !!companyId && open,
  });
  return liveRuns;
}

/** Cancels a batch of runs through the existing per-run cancel endpoint and reports the outcome. */
function useCancelRunsMutation(companyId: string | null | undefined, onSettled: () => void) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  return useMutation({
    mutationFn: (runIds: string[]) =>
      Promise.allSettled(runIds.map((runId) => heartbeatsApi.cancel(runId))),
    onSuccess: (results) => {
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      }
      const failed = results.filter((result) => result.status === "rejected").length;
      const cancelled = results.length - failed;
      if (failed === 0) {
        pushToast({ title: `${plural(cancelled, "run")} stopped`, tone: "success" });
      } else {
        pushToast({
          title: cancelled > 0 ? "Stopped some runs" : "Stop failed",
          body: `${plural(cancelled, "run")} stopped, ${plural(failed, "run")} failed to stop.`,
          tone: cancelled > 0 ? "success" : "error",
        });
      }
      onSettled();
    },
    onError: (err) => {
      pushToast({
        title: "Stop failed",
        body: err instanceof Error ? err.message : "Unable to stop runs",
        tone: "error",
      });
    },
  });
}

/** Derives the agent/task pickers (and their search filtering) from the live-run list. */
function useStopPickerData(liveRuns: LiveRunForIssue[], issues: Issue[], query: string) {
  const agentsWithLiveRuns = useMemo(() => {
    const byAgent = new Map<string, AgentWithLiveRuns>();
    for (const run of liveRuns) {
      const entry = byAgent.get(run.agentId);
      if (entry) entry.runIds.push(run.id);
      else byAgent.set(run.agentId, { agentId: run.agentId, agentName: run.agentName, runIds: [run.id] });
    }
    return Array.from(byAgent.values());
  }, [liveRuns]);

  const issueTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues) map.set(issue.id, issue.title);
    return map;
  }, [issues]);

  const pickerQuery = query.trim().toLowerCase();
  const filteredAgents = useMemo(
    () =>
      pickerQuery
        ? agentsWithLiveRuns.filter((agent) => agent.agentName.toLowerCase().includes(pickerQuery))
        : agentsWithLiveRuns,
    [agentsWithLiveRuns, pickerQuery],
  );
  const filteredTaskRuns = useMemo(() => {
    if (!pickerQuery) return liveRuns;
    return liveRuns.filter((run) => {
      const title = run.issueId ? issueTitleById.get(run.issueId) ?? "" : "";
      return title.toLowerCase().includes(pickerQuery) || run.agentName.toLowerCase().includes(pickerQuery);
    });
  }, [liveRuns, pickerQuery, issueTitleById]);

  return { issueTitleById, filteredAgents, filteredTaskRuns };
}

/**
 * Backs the command palette's "Stop all agents" / "Stop an agent" / "Stop a
 * task" actions. All three cancel one or more heartbeat runs through the
 * same board-only `/heartbeat-runs/:runId/cancel` endpoint the per-issue
 * "Stop and cancel" button already uses, so this adds no server surface.
 */
export function useStopActions({
  companyId,
  open,
  query,
  issues,
}: {
  companyId: string | null | undefined;
  open: boolean;
  query: string;
  issues: Issue[];
}) {
  const [mode, setMode] = useState<StopPickerMode>(null);
  const [pendingStop, setPendingStop] = useState<PendingStop | null>(null);

  const liveRuns = useLiveRuns(companyId, open);
  const cancelRuns = useCancelRunsMutation(companyId, () => setPendingStop(null));
  const picker = useStopPickerData(liveRuns, issues, query);

  function selectStopAll() {
    if (liveRuns.length === 0) {
      setPendingStop(null);
      return;
    }
    setPendingStop({
      title: "Stop all agents?",
      description: `This cancels ${plural(liveRuns.length, "active run")} across every agent in this company.`,
      runIds: liveRuns.map((run) => run.id),
    });
  }

  function selectAgent(agent: AgentWithLiveRuns) {
    setPendingStop({
      title: `Stop ${agent.agentName}?`,
      description: `This cancels ${plural(agent.runIds.length, "active run")} for ${agent.agentName}.`,
      runIds: agent.runIds,
    });
  }

  function selectTask(run: LiveRunForIssue) {
    const title = run.issueId ? picker.issueTitleById.get(run.issueId) ?? "this task" : "this task";
    setPendingStop({
      title: `Stop "${title}"?`,
      description: `This cancels the active run by ${run.agentName}.`,
      runIds: [run.id],
    });
  }

  return {
    mode,
    setMode,
    reset: () => setMode(null),
    liveRunCount: liveRuns.length,
    ...picker,
    selectStopAll,
    selectAgent,
    selectTask,
    pendingStop,
    confirmStop: () => {
      if (pendingStop) cancelRuns.mutate(pendingStop.runIds);
    },
    cancelPendingStop: () => setPendingStop(null),
    isStopping: cancelRuns.isPending,
  };
}

export type StopActions = ReturnType<typeof useStopActions>;

/** The three "Stop..." entries rendered inside the palette's Actions group. */
export function StopActionsMenuItems({
  stop,
  onSelect,
}: {
  stop: StopActions;
  /** Runs after the item's own effect, so the caller can close/reopen the palette as needed. */
  onSelect: (next: "all" | "agent" | "task") => void;
}) {
  return (
    <>
      <CommandItem
        onSelect={() => {
          stop.selectStopAll();
          onSelect("all");
        }}
        data-testid="command-stop-all-agents"
      >
        <CircleStop className="mr-2 h-4 w-4" />
        Stop all agents
        {stop.liveRunCount > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">{plural(stop.liveRunCount, "running")}</span>
        )}
      </CommandItem>
      <CommandItem
        onSelect={() => {
          stop.setMode("agent");
          onSelect("agent");
        }}
        data-testid="command-stop-an-agent"
      >
        <CircleStop className="mr-2 h-4 w-4" />
        Stop an agent...
      </CommandItem>
      <CommandItem
        onSelect={() => {
          stop.setMode("task");
          onSelect("task");
        }}
        data-testid="command-stop-a-task"
      >
        <CircleStop className="mr-2 h-4 w-4" />
        Stop a task...
      </CommandItem>
    </>
  );
}

function AgentPickerGroup({ stop, onPicked }: { stop: StopActions; onPicked: () => void }) {
  return (
    <CommandGroup heading="Agents with active runs">
      {stop.filteredAgents.map((agent) => (
        <CommandItem
          key={agent.agentId}
          onSelect={() => {
            stop.selectAgent(agent);
            onPicked();
          }}
        >
          <Bot className="mr-2 h-4 w-4" />
          <span className="flex-1 truncate">{agent.agentName}</span>
          <span className="ml-auto text-xs text-muted-foreground">{plural(agent.runIds.length, "run")}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function TaskPickerGroup({ stop, onPicked }: { stop: StopActions; onPicked: () => void }) {
  return (
    <CommandGroup heading="Tasks with active runs">
      {stop.filteredTaskRuns.map((run) => (
        <CommandItem
          key={run.id}
          onSelect={() => {
            stop.selectTask(run);
            onPicked();
          }}
        >
          <CircleDot className="mr-2 h-4 w-4" />
          <span className="flex-1 truncate">
            {run.issueId ? stop.issueTitleById.get(run.issueId) ?? run.issueId : "Untitled task"}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{run.agentName}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Replaces the palette's normal content while picking an agent or task to stop. */
export function StopPickerGroup({ stop, onPicked }: { stop: StopActions; onPicked: () => void }) {
  return (
    <>
      <CommandGroup heading={stop.mode === "agent" ? "Stop an agent" : "Stop a task"}>
        <CommandItem onSelect={stop.reset} data-testid="command-stop-back">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </CommandItem>
      </CommandGroup>
      {stop.mode === "agent" ? (
        <AgentPickerGroup stop={stop} onPicked={onPicked} />
      ) : (
        <TaskPickerGroup stop={stop} onPicked={onPicked} />
      )}
      <CommandEmpty>Nothing else is currently running.</CommandEmpty>
    </>
  );
}

export function StopConfirmDialog({ stop }: { stop: StopActions }) {
  return (
    <AlertDialog open={stop.pendingStop !== null} onOpenChange={(next) => !next && stop.cancelPendingStop()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{stop.pendingStop?.title}</AlertDialogTitle>
          <AlertDialogDescription>{stop.pendingStop?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={stop.confirmStop} disabled={stop.isStopping}>
            {stop.isStopping ? "Stopping..." : "Stop"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
