import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

let detachedClient: QueryClient | null = null;

/**
 * The instance's experimental Antigravity swarm setting, for
 * `antigravitySwarmAvailable` (packages/shared). Off until loaded and when
 * there is no query client; the server decides on send either way.
 */
export function useAntigravitySwarmSetting(): { enableAntigravitySwarm: boolean } {
  const contextClient = useContext(QueryClientContext);
  const { data } = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? (detachedClient ??= new QueryClient()),
  );
  return { enableAntigravitySwarm: contextClient != null && data?.enableAntigravitySwarm === true };
}
