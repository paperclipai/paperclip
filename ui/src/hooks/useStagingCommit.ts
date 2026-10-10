import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { retryTransientOnly } from "@/lib/query-client";

export function useStagingCommit(menuOpen: boolean) {
  const isStaging = window.location.hostname.endsWith(".staging.paperclip.app");
const { data } = useQuery({
    // Keep optional menu refresh failures separate from the board's access gate.
    queryKey: queryKeys.stagingCommit,
    queryFn: () => healthApi.get(),
    enabled: isStaging && menuOpen,
    // Opening the menu must refresh the server SHA after a staging rollout.
    staleTime: 0,
    // Menu probe: fail fast so a slow health route does not hang the menu;
    // the SHA is an optional staging aid, not a board access gate.
    retry: retryTransientOnly(0),
  });

  return isStaging ? (data?.commit ?? null) : null;
}