import { useContext } from "react";
import type { InstanceExperimentalSettingsWithManaged } from "@paperclipai/shared";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function resolveArtifactsV1Enabled(settings: Partial<Pick<InstanceExperimentalSettingsWithManaged, "enableArtifactsV1" | "managedKeys">> | null | undefined): boolean {
  return !settings?.managedKeys?.enableArtifactsV1 || settings.enableArtifactsV1 !== false;
}

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Artifacts V1: the artifact directions lab's presentation on the Artifacts
 * page, the panel's Artifacts tab and the task thread. On for every instance,
 * with no setting to change it: writes persist every flag, so a stored false
 * only means an instance saved some other experiment. A hosting operator's
 * managed value can still hold it off. Off when rendered outside a query
 * client, as the app root is in some harnesses. See
 * doc/plans/2026-10-22-artifacts-mvp-v1.md.
 */
export function useArtifactsV1Enabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );

  if (!contextClient) return { enabled: false, loaded: true };

  return {
    enabled: resolveArtifactsV1Enabled(query.data),
    loaded: query.isFetched,
  };
}
