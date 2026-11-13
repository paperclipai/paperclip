import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/** Default-off setup gate. Existing connections and their grants remain usable. */
export function useMemoryConnectorsEnabled() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // Derive the gate from data, not `isError`: cached settings stay visible while a
  // refetch is failing; only a no-data failure reports `loaded` without the flag.
  return { enabled: query.data?.enableMemoryConnectors === true, loaded: query.isFetched };
}
