import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

export function useBoardAccess() {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  const authResolved = healthQuery.isFetched && (!isAuthenticatedMode || sessionQuery.isFetched);
  const hasBoardAccess = healthQuery.isFetched && (!isAuthenticatedMode || !!sessionQuery.data);

  return {
    authResolved,
    hasBoardAccess,
    isAuthenticatedMode,
    session: sessionQuery.data ?? null,
  };
}
