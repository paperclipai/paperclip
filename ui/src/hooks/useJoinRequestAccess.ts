import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";

export function useJoinRequestAccess(companyId: string | null | undefined) {
  const { data } = useQuery({
    queryKey: queryKeys.access.joinRequestAccess(companyId ?? ""),
    queryFn: () => accessApi.getJoinRequestAccess(companyId!),
    enabled: !!companyId,
    retry: false,
  });
  return data?.canApproveJoins;
}
