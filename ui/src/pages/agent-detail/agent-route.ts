import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { agentRouteRef } from "@/lib/utils";

/**
 * Agent detail URLs use a name-derived key, so updates that change the agent's
 * name (a rename or a config-revision rollback) can invalidate the reference
 * currently in the URL. When that happens, refetching the old reference would
 * 404 with "Agent not found". Instead, drop the stale cached queries and
 * replace the URL with the new canonical reference. Returns true when a
 * redirect happened.
 */
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
