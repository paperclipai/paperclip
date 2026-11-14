import { useQueryView } from "@/components/QueryView";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function useFastResponsesEnabled() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const queryView = useQueryView(query);
  return { enabled: !(queryView.kind === "error") && query.data?.enableFastResponses === true, loaded: query.isFetched };
}
