import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";

export function useSelectedHeartbeatRun(
  runs: HeartbeatRun[],
  selectedRunId: string | null,
  companyId: string,
  agentId: string,
) {
  const listedRun = runs.find(run => run.id === selectedRunId) ?? null;
  const query = useQuery({
    queryKey: queryKeys.runDetail(selectedRunId ?? ""),
    queryFn: () => heartbeatsApi.get(selectedRunId!),
    enabled: Boolean(selectedRunId && !listedRun),
  });
  const fetchedRun = query.data?.id === selectedRunId && query.data.companyId === companyId && query.data.agentId === agentId ? query.data : null;
  return { run: listedRun ?? fetchedRun, loading: query.isPending, error: query.error, retry: query.refetch };
}
