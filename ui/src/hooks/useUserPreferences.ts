import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";

export function useUserPreferences() {
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const userId = session.data?.user?.id ?? null;
  return useQuery({
    queryKey: queryKeys.auth.preferences(userId),
    queryFn: () => authApi.getPreferences(),
    enabled: !!userId,
    retry: false,
  });
}
