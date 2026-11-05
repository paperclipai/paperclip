import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

let detachedClient: QueryClient | null = null;

/** Shared task-composer preference, including isolated previews without a query provider. */
export function useComposerSubmitKey(): "enter" | "mod-enter" {
  const contextClient = useContext(QueryClientContext);
  if (!contextClient) detachedClient ??= new QueryClient();
  const { data } = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? detachedClient!,
  );
  return contextClient && data?.enableLegacyComposerSubmit === true ? "mod-enter" : "enter";
}
