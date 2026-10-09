import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function resolveStreamlinedUiEnabled(
  settings:
    | Pick<InstanceExperimentalSettings, "enableStreamlinedUi">
    | null
    | undefined,
): boolean {
  return settings?.enableStreamlinedUi !== false;
}

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * The streamlined shell is the default experience. Missing legacy values,
 * loading states, and read failures all fail open so the app never flashes or
 * falls back to the legacy shell unless an instance explicitly opts out.
 */
export function useStreamlinedUiEnabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );

  if (!contextClient) return { enabled: true, loaded: true };

  return {
    enabled: resolveStreamlinedUiEnabled(query.data),
    loaded: query.isFetched,
  };
}
