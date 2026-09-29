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
  const preferences = useQuery({
    queryKey: queryKeys.auth.preferences(userId),
    queryFn: () => authApi.getPreferences(userId!),
    enabled: !!userId,
    retry: false,
  });
  return { ...preferences, data: preferences.isError ? undefined : preferences.data };
}
