import { useContext } from "react";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function resolveArtifactsV1Enabled(settings: Partial<Pick<InstanceExperimentalSettings, "enableArtifactsV1">> | null | undefined): boolean {
  return settings?.enableArtifactsV1 === true;
}

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Artifacts V1 (Settings > Experimental): the artifact directions lab's
 * presentation on the Artifacts page, the panel's Artifacts tab and the task
 * thread. Off by default — and off when rendered outside a query client, as
 * the app root is in some harnesses — so every surface renders as before
 * until an instance opts in. See doc/plans/2026-10-22-artifacts-mvp-v1.md.
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
