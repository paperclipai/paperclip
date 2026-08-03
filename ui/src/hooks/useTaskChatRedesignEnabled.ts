import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Fallback client for hosts that render gated components without a
 * QueryClientProvider (isolated unit-test mounts, storybook-style renders).
 * The query is disabled in that case, so this client never fetches — it only
 * keeps `useQuery` from throwing. Created lazily so app code never pays for it.
 */
let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Task Chat Redesign experimental flag.
 *
 * Wraps the shared experimental-settings query so gated call sites don't
 * repeat the boilerplate. `enabled` stays false while the query is in flight
 * (no flash of gated UI); `loaded` lets route gates avoid redirecting away
 * before the flag value is actually known.
 *
 * Renders without a QueryClientProvider resolve to the flag-off default
 * (`{ enabled: false, loaded: true }`) instead of throwing, so widely shared
 * leaf components (e.g. the task detail thread) stay mountable in isolation —
 * and, critically, flag-off is provably the current behavior.
 */
export function useTaskChatRedesignEnabled(): { enabled: boolean; loaded: boolean } {
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
  return { enabled: data?.enableTaskChatRedesign === true, loaded: isFetched };
}
