import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Reads Paperclip Cloud metadata from the app-wide health query cache.
 * CloudAccessGate owns the fetch; disabling this observer's query function
 * prevents consumers from adding another health request when they mount.
 */
export function useCloudInstance() {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: false,
  });

  return healthQuery.data?.cloud ?? null;
}
