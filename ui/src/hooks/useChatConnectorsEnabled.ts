import { useContext } from "react";
import {
  QueryClient,
  QueryClientContext,
  useQuery,
} from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

let detachedClient: QueryClient | null = null;

/** One default-off visibility gate; this does not pause existing provider delivery. */
export function useChatConnectorsEnabled(): {
  enabled: boolean;
  loaded: boolean;
} {
  const contextClient = useContext(QueryClientContext);
  const { data, isFetched, isError } = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? (detachedClient ??= new QueryClient()),
  );
  if (!contextClient) return { enabled: false, loaded: true };
  return {
    enabled: !isError && data?.enableChatConnectors === true,
    loaded: isFetched,
  };
}
