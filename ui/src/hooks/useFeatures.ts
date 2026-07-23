import { useQuery } from "@tanstack/react-query";
import type { CurrentBoardAccess } from "@/api/access";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Board access + capabilities from GET /cli-auth/me. Single cache entry
 * (queryKeys.access.currentBoardAccess) shared by nav gating and feature
 * flags. Degrades closed: consumers must treat `undefined` data as
 * "nothing exposed / no features enabled".
 */
export function useBoardCapabilities() {
  return useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Public feature flags for the signed-in board user. Replaces every
 * non-admin read of /instance/settings, /general, /experimental — those
 * endpoints are instance-admin-only as of PR-1 (settings-surface policy).
 */
export function useFeatures() {
  return useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    staleTime: 30_000,
    retry: false,
    select: (access: CurrentBoardAccess) => access.capabilities.features,
  });
}
