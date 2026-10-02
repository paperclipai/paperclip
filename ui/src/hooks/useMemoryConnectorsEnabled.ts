import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/** Default-off setup gate. Existing connections and their grants remain usable. */
export function useMemoryConnectorsEnabled() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  return { enabled: !query.isError && query.data?.enableMemoryConnectors === true, loaded: query.isFetched };
}
