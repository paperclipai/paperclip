import { useQuery } from "@tanstack/react-query";
import type { ManagedExperimentalFeatureKey } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";

export function useExperimentalFlag(key: ManagedExperimentalFeatureKey) {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const queryView = useQueryView(query);
  return { enabled: !(queryView.kind === "error") && query.data?.[key] === true, loaded: query.isFetched };
}
