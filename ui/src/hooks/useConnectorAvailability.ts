import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { isConnectorFeatureEnabled, type AppDefinition } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function useConnectorAvailability() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const enabled = useCallback((app: AppDefinition | null | undefined) =>
    isConnectorFeatureEnabled(app, query.isError ? undefined : query.data), [query.data, query.isError]);
  return { enabled, loaded: query.isFetched, failed: query.isError };
}
