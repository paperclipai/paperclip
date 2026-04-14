import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { AgentFileRow } from "../components/AgentFileRow";
import type { FileEditEvent } from "../components/FileCard";
import type { LiveRunForIssue } from "../api/heartbeats";

function parseFileEditPayload(payload: Record<string, unknown>): {
  runId: string;
  agentId: string;
  event: FileEditEvent;
} | null {
  const data = payload.payload as Record<string, unknown> | null;
  const runId = payload.runId as string;
  const agentId = payload.agentId as string;
  if (!data || !runId) return null;

  return {
    runId,
    agentId,
    event: {
      filePath: (data.filePath as string) ?? "unknown",
      editType: (data.editType as FileEditEvent["editType"]) ?? "modify",
      diff: (data.diff as string) ?? "",
      linesAdded: (data.linesAdded as number) ?? 0,
      linesRemoved: (data.linesRemoved as number) ?? 0,
      timestamp: (data.timestamp as string) ?? new Date().toISOString(),
      seq: (payload.seq as number) ?? 0,
    },
  };
}

export function Visibility() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Visibility" }]);
  }, [setBreadcrumbs]);

  // minCount=4 ensures we see recently-finished runs too (not just queued/running),
  // so cards don't vanish the instant a run completes.
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "visibility"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, 4),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const { data: hydrated } = useQuery({
    queryKey: [...queryKeys.visibilityFileEvents(selectedCompanyId!), "hydration"],
    queryFn: () => heartbeatsApi.fileEventsForActiveRuns(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchOnMount: true,
    staleTime: 0,
  });

  // Subscribe to WS-pushed file events via useQuery so the component re-renders
  // when LiveUpdatesProvider appends events via setQueryData.
  const { data: wsEvents = [] } = useQuery({
    queryKey: queryKeys.visibilityFileEvents(selectedCompanyId!),
    queryFn: () => [] as Array<Record<string, unknown>>,
    enabled: !!selectedCompanyId,
    staleTime: Infinity,
  });

  const agentFiles = useMemo(() => {
    const map = new Map<string, { run: LiveRunForIssue | undefined; files: Map<string, FileEditEvent[]> }>();

    for (const run of liveRuns ?? []) {
      if (!map.has(run.id)) {
        map.set(run.id, { run, files: new Map() });
      }
    }

    if (hydrated?.runs) {
      for (const [runId, { events }] of Object.entries(hydrated.runs)) {
        if (!map.has(runId)) {
          const run = liveRuns?.find((r) => r.id === runId);
          map.set(runId, { run, files: new Map() });
        }
        const entry = map.get(runId)!;
        for (const ev of events) {
          const data = ev.payload as Record<string, unknown> | null;
          if (!data) continue;
          const filePath = (data.filePath as string) ?? "unknown";
          const existing = entry.files.get(filePath) ?? [];
          existing.push({
            filePath,
            editType: (data.editType as FileEditEvent["editType"]) ?? "modify",
            diff: (data.diff as string) ?? "",
            linesAdded: (data.linesAdded as number) ?? 0,
            linesRemoved: (data.linesRemoved as number) ?? 0,
            timestamp: (data.timestamp as string) ?? "",
            seq: ev.seq,
          });
          entry.files.set(filePath, existing);
        }
      }
    }

    for (const payload of wsEvents) {
      const parsed = parseFileEditPayload(payload);
      if (!parsed) continue;
      if (!map.has(parsed.runId)) {
        const run = liveRuns?.find((r) => r.id === parsed.runId);
        map.set(parsed.runId, { run, files: new Map() });
      }
      const entry = map.get(parsed.runId)!;
      const existing = entry.files.get(parsed.event.filePath) ?? [];
      if (!existing.some((e) => e.seq === parsed.event.seq)) {
        existing.push(parsed.event);
        entry.files.set(parsed.event.filePath, existing);
      }
    }

    return map;
  }, [liveRuns, hydrated, wsEvents]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    const activeRunIds = new Set((liveRuns ?? []).map((r) => r.id));
    queryClient.setQueryData<Array<Record<string, unknown>>>(
      queryKeys.visibilityFileEvents(selectedCompanyId),
      (old) => (old ?? []).filter((e) => activeRunIds.has(e.runId as string)),
    );
  }, [liveRuns, selectedCompanyId, queryClient]);

  if (!selectedCompanyId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Eye className="h-10 w-10 mb-2 opacity-40" />
        <p>Select a company to view agent activity</p>
      </div>
    );
  }

  // Only show runs that have file events or are still active
  const visibleRuns = Array.from(agentFiles.entries()).filter(([, { run, files }]) => {
    if (files.size > 0) return true;
    return run?.status === "running" || run?.status === "queued";
  });

  return (
    <div className="p-6 space-y-6">
      {visibleRuns.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[60vh] text-muted-foreground">
          <Eye className="h-10 w-10 mb-2 opacity-40" />
          <p className="text-sm">No active runs</p>
        </div>
      ) : (
        visibleRuns.map(([runId, { run, files }]) => (
          <AgentFileRow
            key={runId}
            agentName={run?.agentName ?? "Unknown Agent"}
            issueTitle={run?.triggerDetail ?? undefined}
            files={files}
            runStatus={run?.status ?? "running"}
          />
        ))
      )}
    </div>
  );
}
