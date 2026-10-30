import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { agentRouteRef } from "@/lib/utils";

export function syncAgentRouteAfterRename(
  queryClient: QueryClient,
  navigate: NavigateFunction,
  previous: { id: string; urlKey?: string | null; name?: string | null },
  updated: { id: string; urlKey?: string | null; name?: string | null },
  tab: string,
): boolean {
  const previousRef = agentRouteRef(previous);
  const nextRef = agentRouteRef(updated);
  if (nextRef === previousRef) return false;
  queryClient.removeQueries({ queryKey: queryKeys.agents.detail(previousRef) });
  navigate(`/agents/${nextRef}/${tab}`, { replace: true });
  return true;
}
