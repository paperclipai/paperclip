import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import type { PermissionKey } from "@paperclipai/shared";

export function useMyPermissions(companyId: string | null | undefined) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.access.myPermissions(companyId!),
    queryFn: () => accessApi.getMyPermissions(companyId!),
    enabled: !!companyId,
    staleTime: 30_000,
  });

  const permissions = new Set<string>(data?.permissions ?? []);

  return {
    role: data?.membershipRole ?? null,
    permissions,
    can: (key: PermissionKey) => permissions.has(key),
    isLoading,
  };
}
