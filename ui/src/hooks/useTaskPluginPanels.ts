import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { api } from "@/api/client";
import { heartbeatsApi } from "@/api/heartbeats";
import { useHasCompanyLiveConnection } from "@/context/LiveUpdatesProvider";
import { liveRunRefetchInterval } from "@/lib/live-runs-cache";
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
  const savedTask = enabled && !!issue && !issue.id.startsWith("chat:");
  const connected = useHasCompanyLiveConnection(issue?.companyId);
  const { slots, errorMessage } = usePluginSlots({
    slotTypes: ["detailTab"], entityType: "agent", taskSidePanel: true,
    companyId: issue?.companyId, enabled: savedTask,
  });
  const { data: runs, isError: runsError } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issue?.id ?? "pending"),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issue!.id),
    enabled: savedTask && slots.length > 0 && !errorMessage,
    refetchInterval: query => liveRunRefetchInterval(connected, query.state, 3000),
    retry: false,
  });
  const run = runs?.find(run => run.status === "running"
    && (!issue?.executionRunId || run.id === issue.executionRunId));
  const active = savedTask && slots.length > 0 && !!run && !runsError && !errorMessage;
  const availability = useQueries({ queries: slots.map(slot => ({
    queryKey: ["task-plugin-panel", issue?.companyId, issue?.id, run?.id, run?.agentId, slot.pluginKey, slot.id, slot.pluginVersion],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<{ available: boolean }>(
      `/plugins/${encodeURIComponent(slot.pluginId)}/api${slot.taskSidePanel!.availabilityPath.replace(":entityId", encodeURIComponent(run!.agentId))}`,
      { signal, cache: "no-store" },
    ),
    enabled: active,
    refetchInterval: 3000,
    retry: false,
  })) });
  const available = availability.map(result => !result.isError && result.data?.available === true);
  const availableKey = available.join(",");
  return useMemo(() => active && run ? slots.flatMap((slot, index) => available[index]
    ? [{ entityId: run.agentId, runId: run.id, slot }] : []) : EMPTY_PANELS,
  [active, run?.agentId, run?.id, slots, availableKey]);
}
