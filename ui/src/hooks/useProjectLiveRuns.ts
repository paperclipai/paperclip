import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";

export interface ProjectLiveRunInfo {
  count: number;
  firstRunId: string;
  agentRef: string;
}

export function useProjectLiveRuns(companyId: string | undefined) {
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });

  return useMemo(() => {
    const map = new Map<string, ProjectLiveRunInfo>();
    for (const run of liveRuns ?? []) {
      if (!run.projectId) continue;
      const existing = map.get(run.projectId);
      if (existing) {
        existing.count++;
      } else {
        map.set(run.projectId, {
          count: 1,
          firstRunId: run.id,
          agentRef: run.agentName ?? run.agentId,
        });
      }
    }
    return map;
  }, [liveRuns]);
}
