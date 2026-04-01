import { useQuery } from "@tanstack/react-query";
import { meAccessApi, type MeAccessInfo } from "../api/userInvites";
import { queryKeys } from "../lib/queryKeys";

/**
 * Hook that fetches the current user's access info including
 * whether they are an instance admin and their company memberships with roles.
 */
export function useMeAccess(): {
  isInstanceAdmin: boolean;
  memberships: MeAccessInfo["memberships"];
  isLoading: boolean;
  getRoleForCompany: (companyId: string) => string;
} {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => meAccessApi.get(),
    retry: false,
    staleTime: 60_000,
  });

  function getRoleForCompany(companyId: string): string {
    if (!data) return "member";
    const membership = data.memberships.find((m) => m.companyId === companyId);
    return membership?.role ?? "member";
  }

  return {
    isInstanceAdmin: data?.isInstanceAdmin ?? false,
    memberships: data?.memberships ?? [],
    isLoading,
    getRoleForCompany,
  };
}
