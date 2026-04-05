import { useQuery } from "@tanstack/react-query";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

export interface UseIsRaavaResult {
  isRaava: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

/**
 * Returns the FleetOS (Raava) mode status along with loading/error state.
 * Uses the cached health query so there is no extra network request.
 *
 * Callers can destructure `{ isRaava }` for the simple boolean, or inspect
 * `isLoading` / `isError` / `error` to distinguish "not fleetos" from
 * "health API failed".
 */
export function useIsRaava(): UseIsRaavaResult {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: 60_000,
  });
  return {
    isRaava: healthQuery.data?.deploymentMode === "fleetos",
    isLoading: healthQuery.isLoading,
    isError: healthQuery.isError,
    error: healthQuery.error,
  };
}
