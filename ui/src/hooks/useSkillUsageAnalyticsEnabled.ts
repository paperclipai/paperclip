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
 * Skill Usage Analytics experimental flag (LOOA-956/957).
 *
 * Wraps the board-readable experimental-settings GET (same query the sidebar
 * and `InstanceExperimentalSettings` use) so the skill browser's usage sort,
 * card stats, and Studio usage detail all share one gate. `enabled` stays
 * false while the query is in flight (no flash of gated UI, matching the
 * sidebar's `showWorkspacesLink` pattern); `loaded` lets route gates avoid
 * redirecting before the flag value is known.
 *
 * Renders without a QueryClientProvider resolve to the flag-off default
 * (`{ enabled: false, loaded: true }`) instead of throwing.
 */
export function useSkillUsageAnalyticsEnabled(): { enabled: boolean; loaded: boolean } {
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
  return { enabled: data?.enableSkillUsageAnalytics === true, loaded: isFetched };
}
