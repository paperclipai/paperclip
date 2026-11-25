import { useQueryView } from "@/components/QueryView";
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
  const queryView = useQueryView(query);
  const enabled = useCallback((app: AppDefinition | null | undefined) =>
    isConnectorFeatureEnabled(app, (queryView.kind === "error") ? undefined : query.data), [query.data, (queryView.kind === "error")]);
  return { enabled, loaded: query.isFetched, failed: (queryView.kind === "error") };
}
