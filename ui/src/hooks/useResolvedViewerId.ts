import { useQuery, type QueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

export function useResolvedViewerId(options?: { client?: QueryClient; enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), enabled }, options?.client);
  const sessionUserId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const health = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), enabled: enabled && session.isSuccess && !sessionUserId }, options?.client);
  return {
    userId: session.isSuccess ? sessionUserId ?? (health.isSuccess && health.data.deploymentMode === "local_trusted" ? "local-board" : null) : null,
    loaded: session.isFetched && (!!sessionUserId || session.isError || health.isFetched),
    error: session.error ?? (!sessionUserId ? health.error : null),
    retry: async () => {
      if (session.isError) return session.refetch();
      if (!sessionUserId && health.isError) return health.refetch();
    },
  };
}
