import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Fallback client for hosts that render gated components without a
 * QueryClientProvider (isolated unit-test mounts). The query is disabled in
 * that case, so this client never fetches — it only keeps `useQuery` from
 * throwing. Created lazily so app code never pays for it.
 */
let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Smoke Lab experimental flag (PAP-13343 / S2, plan §D3).
 *
 * Wraps the board-readable experimental-settings GET (same query the sidebar
 * and `InstanceExperimentalSettings` use) so the Smoke Lab tab, its sidebar
 * nav item, and the dashboard card share one gate. `enabled` stays false while
 * the query is in flight (no flash of gated UI, matching the sidebar's
 * `showWorkspacesLink` pattern); `loaded` lets route gates avoid redirecting
 * before the flag value is known.
 *
 * Renders without a QueryClientProvider resolve to the flag-off default
 * (`{ enabled: false, loaded: true }`) instead of throwing.
 */
export function useSmokeLabEnabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const { data, isFetched } = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );
  if (!contextClient) {
    return { enabled: false, loaded: true };
  }
  return { enabled: data?.enableSmokeLab === true, loaded: isFetched };
}
