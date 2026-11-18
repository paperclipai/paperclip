import { useQuery } from "@tanstack/react-query";
import type { ResponsibilityRecentRuns } from "@paperclipai/shared";
import { responsibilityRunsApi } from "@/api/responsibility-runs";
import { queryKeys } from "@/lib/queryKeys";

const LIVE = new Set(["queued", "running"]);

/**
 * The most recent agent runs on the work under a responsibility, newest
 * first. Polls while a run is queued or running so it settles on its own.
 * The One screen v2 layout shows them as its "Recent runs" table.
 */
export function useResponsibilityRuns(responsibilityId: string) {
  return useQuery({
    queryKey: queryKeys.responsibilities.runs(responsibilityId),
    queryFn: () => responsibilityRunsApi.recent(responsibilityId),
    staleTime: 15_000,
    refetchInterval: (query) => ((query.state.data as ResponsibilityRecentRuns | undefined)?.runs.some((run) => LIVE.has(run.status)) ? 5_000 : false),
  });
}
