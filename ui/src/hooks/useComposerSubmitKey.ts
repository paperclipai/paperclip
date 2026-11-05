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
  if (!contextClient) return "enter";
  // Keep plain Enter safe until the saved preference is known on a cold load.
  return !data || data.enableLegacyComposerSubmit === true ? "mod-enter" : "enter";
}
