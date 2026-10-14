import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

export function useStagingCommit(menuOpen: boolean) {
  const isStaging = window.location.hostname.endsWith(".staging.paperclip.app");
  const { data, isError } = useQuery({
    // Keep optional menu refresh failures separate from the board's access gate.
    queryKey: queryKeys.stagingCommit,
    queryFn: () => healthApi.get(),
    enabled: isStaging && menuOpen,
    // Opening the menu must refresh the server SHA after a staging rollout.
    staleTime: 0,
    retry: false,
  });

  return isStaging && !isError ? data?.commit ?? null : null;
}
