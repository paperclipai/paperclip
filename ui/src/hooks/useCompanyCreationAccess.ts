import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

/** Mirrors POST /companies. Organization roles do not grant instance administration. */
export function canCreateCompany(access: CurrentBoardAccess | undefined): boolean {
  return Boolean(access && (access.source === "local_implicit" || access.isInstanceAdmin));
}

export function useCompanyCreationAccess(enabled = true) {
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  return {
    canCreateCompany: enabled && access.isSuccess && canCreateCompany(access.data),
    isPending: access.isPending,
    isError: access.isError,
    refetch: access.refetch,
  };
}
