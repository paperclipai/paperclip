import { useEffect, useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { api, ApiError } from "@/api/client";
import { heartbeatsApi } from "@/api/heartbeats";
import { useTaskRunLiveUpdates, useTranscriptLiveStream } from "@/context/LiveUpdatesProvider";
import { createLiveQueryRecovery } from "@/lib/live-query-recovery";
import { QueryNotReadyError } from "@/lib/query-client";
import { queryKeys } from "@/lib/queryKeys";
import { usePluginSlots, type ResolvedPluginSlot } from "@/plugins/slots";

export interface TaskPluginPanel {
  entityId: string;
  runId: string;
  slot: ResolvedPluginSlot;
}

const EMPTY_PANELS: TaskPluginPanel[] = [];

export function taskPluginPanelId(panel: TaskPluginPanel) {
  return `plugin:${panel.slot.pluginKey}:${panel.slot.id}:${panel.entityId}`;
}

/** Plugins own availability and content; the host supplies the running agent. */
export function useTaskPluginPanels(issue: Issue | null | undefined, enabled = true): TaskPluginPanel[] {
  const queryClient = useQueryClient();
  const savedTask = enabled && !!issue && !issue.id.startsWith("chat:");
  const { slots: declaredSlots, errorMessage } = usePluginSlots({
    slotTypes: ["detailTab"], entityType: "agent", taskSidePanel: true,
    companyId: issue?.companyId, enabled: savedTask,
  });
  const slots = useMemo(() => declaredSlots.filter(slot => slot.taskSidePanel?.activation), [declaredSlots]);
  const connected = useTaskRunLiveUpdates({
    companyId: savedTask && slots.length > 0 && !errorMessage ? issue?.companyId : null,
    issueId: issue?.id, issueQueryRef: issue?.id ?? "pending", assigneeAgentId: issue?.assigneeAgentId,
  });
  const { data: runs, isError: runsError } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issue?.id ?? "pending"),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issue!.id),
    enabled: savedTask && slots.length > 0 && !errorMessage,
    refetchInterval: connected ? false : 3000,
    retry: (failures: number, error: Error) => failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    retryDelay: 1000,
  });
  const run = runs?.find(run => run.status === "running"
    && (!issue?.executionRunId || run.id === issue.executionRunId));
  const active = savedTask && slots.length > 0 && !!run && !runsError && !errorMessage;
  const declarations = slots.map(slot => [slot.pluginKey, slot.id, slot.pluginVersion,
    slot.taskSidePanel!.activation!.namespace, slot.taskSidePanel!.activation!.activityKey]);
  const activationScope = JSON.stringify(declarations);
  const activationKey = ["task-plugin-panel-activations", issue?.companyId, issue?.id, run?.id, run?.agentId, activationScope];
  // Keep unchanged declarations active while a new declaration scope loads.
  const retained = new Map<string, { pluginKey: string; slotId: string }>();
  for (const [key, panels] of queryClient.getQueriesData<Array<{ pluginKey: string; slotId: string }>>({ queryKey: activationKey.slice(0, 5) })) {
    if (typeof key[5] !== "string" || queryClient.getQueryState(key)?.status !== "success") continue;
    const unchanged = (JSON.parse(key[5]) as string[][]).filter(previous =>
      declarations.some(current => current.every((part, index) => part === previous[index])));
    for (const panel of panels ?? []) if (unchanged.some(declaration => declaration[0] === panel.pluginKey && declaration[1] === panel.slotId)) {
      retained.set(JSON.stringify([panel.pluginKey, panel.slotId]), panel);
    }
  }
  const { data: recordedActivations = [], isError: activationsError } = useQuery({
    queryKey: activationKey,
    queryFn: ({ signal }) => heartbeatsApi.taskPanelActivations(run!.id, { signal, cache: "no-store" }),
    initialData: () => retained.size ? [...retained.values()] : undefined,
    initialDataUpdatedAt: 0,
    // Run activations only grow; merge history and live hints when committing cache data.
    structuralSharing: (previous, incoming) => {
      const merged = new Map(retained);
      for (const panel of [...((previous ?? []) as Array<{ pluginKey: string; slotId: string }>), ...(incoming as Array<{ pluginKey: string; slotId: string }>)]) {
        merged.set(JSON.stringify([panel.pluginKey, panel.slotId]), panel);
      }
      return [...merged.values()];
    },
    staleTime: 0,
    enabled: active,
    retry: (failures: number, error: Error) => failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    retryDelay: 1000,
  });
  const activations = [...recordedActivations, ...retained.values()];
  const stream = useTranscriptLiveStream(active ? [run!.id] : [], { companyId: issue?.companyId, enabled: active }, event => {
    if (!active || !run || event.companyId !== issue?.companyId || event.payload.runId !== run.id
      || event.payload.agentId !== run.agentId || event.payload.issueId !== issue?.id
      || event.type !== "heartbeat.run.event" || event.payload.eventType !== "runtime.activity.recorded") return;
    const native = event.payload.payload as { prpEvent?: { eventType?: string; sourceKind?: string; payload?: unknown } } | null;
    if (native?.prpEvent?.eventType !== "runtime.activity.recorded" || native.prpEvent.sourceKind !== "runner") return;
    const activity = native.prpEvent.payload as { namespace?: unknown; activityKey?: unknown } | null;
    if (!activity || Object.keys(activity).length !== 2 || typeof activity.namespace !== "string" || typeof activity.activityKey !== "string") return;
    const panels = slots.filter(slot => slot.taskSidePanel?.activation?.namespace === activity.namespace
      && slot.taskSidePanel?.activation?.activityKey === activity.activityKey)
      .map(slot => ({ pluginKey: slot.pluginKey, slotId: slot.id }));
    if (!panels.length) return;
    queryClient.setQueryData<Array<{ pluginKey: string; slotId: string }>>(activationKey, previous => {
      const missing = panels.filter(panel => !previous?.some(item => item.pluginKey === panel.pluginKey && item.slotId === panel.slotId));
      return missing.length ? [...(previous ?? []), ...missing] : previous;
    });
    for (const panel of panels) void queryClient.invalidateQueries({
      queryKey: ["task-plugin-panel", issue?.companyId, issue?.id, run.id, run.agentId, panel.pluginKey, panel.slotId],
      predicate: ({ state }) => state.status === "error" && state.fetchStatus === "idle"
        && !(state.error instanceof ApiError && state.error.status >= 400 && state.error.status < 500),
    });
  });
  useEffect(() => {
    if (!active || !stream.healthy) return;
    let current = true;
    void queryClient.invalidateQueries({ queryKey: ["task-plugin-panel", issue?.companyId, issue?.id, run?.id, run?.agentId] });
    // A pre-subscription history read must settle before the recovery read.
    createLiveQueryRecovery(queryClient, () => current, { queryKey: activationKey, exact: true })();
    return () => { current = false; };
  }, [active, stream.healthy, stream.epoch, queryClient, issue?.companyId, issue?.id, run?.id, run?.agentId, activationScope]);
  const availability = useQueries({ queries: slots.map(slot => ({
    queryKey: ["task-plugin-panel", issue?.companyId, issue?.id, run?.id, run?.agentId, slot.pluginKey, slot.id, slot.pluginVersion, slot.pluginId, slot.taskSidePanel!.availabilityPath],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const result = await api.get<{ available: boolean }>(
        `/plugins/${encodeURIComponent(slot.pluginId)}/api${slot.taskSidePanel!.availabilityPath.replace(":entityId", encodeURIComponent(run!.agentId))}?runId=${encodeURIComponent(run!.id)}&issueId=${encodeURIComponent(issue!.id)}`,
        { signal, cache: "no-store" },
      );
      if (result.available !== true) throw new QueryNotReadyError("Plugin panel is not ready");
      return result;
    },
    enabled: active && !activationsError && activations.some(panel => panel.pluginKey === slot.pluginKey && panel.slotId === slot.id),
    retry: (failures: number, error: Error) => failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    retryDelay: 1000,
  })) });
  const available = availability.map((result, index) => !activationsError && !result.isError && result.data?.available === true
    && activations.some(panel => panel.pluginKey === slots[index]?.pluginKey && panel.slotId === slots[index]?.id));
  const availableKey = available.join(",");
  return useMemo(() => active && run ? slots.flatMap((slot, index) => available[index]
    ? [{ entityId: run.agentId, runId: run.id, slot }] : []) : EMPTY_PANELS,
  [active, run?.agentId, run?.id, slots, availableKey]);
}
