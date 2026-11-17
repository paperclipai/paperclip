import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/** Keeps `useQuery` mountable without a provider; never fetches (query disabled). */
let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Areas of responsibility experimental flag (`enableResponsibilities`).
 *
 * Reads the shared experimental-settings query, so it costs nothing beyond
 * what the shell already loads. `enabled` stays false while the query is in
 * flight (no flash of gated UI); `loaded` lets route gates and the home-path
 * decision wait for the real value instead of redirecting early.
 *
 * Without a QueryClientProvider it resolves to the flag-off default
 * (`{ enabled: false, loaded: true }`), so shared nav components stay
 * mountable in isolation.
 */
export function useResponsibilitiesEnabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const { data, isFetched } = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );
  if (!contextClient) return { enabled: false, loaded: true };
  return { enabled: data?.enableResponsibilities === true, loaded: isFetched };
}
