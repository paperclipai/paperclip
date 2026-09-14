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
 * Classic Task Interface experimental flag (`enableClassicTaskInterface`).
 *
 * Wraps the shared experimental-settings query so gated call sites don't
 * repeat the boilerplate. Fail-closed to chat-style: `enabled` stays false
 * while the query is in flight, on fetch errors, and in renders without a
 * QueryClientProvider (isolated unit-test mounts), so the default chat-style
 * view is what renders unless the classic opt-in is provably on. `loaded`
 * lets hosts that care distinguish "flag is off" from "flag not yet known".
 */
export function useClassicTaskInterfaceEnabled(): { enabled: boolean; loaded: boolean } {
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
  return { enabled: data?.enableClassicTaskInterface === true, loaded: isFetched };
}
