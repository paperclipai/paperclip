import { useContext } from "react";
import {
  QueryClient,
  QueryClientContext,
  useQuery,
} from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

let detachedClient: QueryClient | null = null;

/** Independent default-off visibility gates; these do not pause existing provider delivery. */
export function useChatConnectorsEnabled(): {
  enabled: boolean;
  loaded: boolean;
  githubEnabled: boolean;
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
  if (!contextClient)
    return { enabled: false, githubEnabled: false, loaded: true };
  return {
    enabled: !isError && data?.enableChatConnectors === true,
    githubEnabled: !isError && data?.enableGitHubReviewBots === true,
    loaded: isFetched,
  };
}

/** Provider visibility only; never changes an existing connection's permissions. */
export function chatProviderVisible(
  provider: string | null | undefined,
  chatEnabled: boolean,
  githubEnabled: boolean,
) {
  return (
    provider === "agentmail" ||
    (provider === "github" || provider === "github-code-review-bot"
      ? githubEnabled
      : chatEnabled)
  );
}
