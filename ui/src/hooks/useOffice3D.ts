import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Fallback client for hosts that render without a QueryClientProvider (isolated
 * unit-test mounts). The query is disabled there, so it never fetches — it only
 * keeps `useQuery` from throwing. Lazily created so app code never pays for it.
 */
let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * CLAW3D "3D office" URL from instance experimental settings. When set, the
 * Org → Office view reveals a 2.5D⇄3D toggle that embeds CLAW3D. Reuses the
 * same board-readable experimental-settings GET the sidebar uses. Renders
 * without a QueryClientProvider resolve to `{ url: null, loaded: true }`.
 */
export function useOffice3D(): { url: string | null; loaded: boolean } {
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
    return { url: null, loaded: true };
  }
  return { url: data?.office3dUrl ?? null, loaded: isFetched };
}
