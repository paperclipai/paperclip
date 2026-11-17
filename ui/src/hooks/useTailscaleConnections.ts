import { useQuery } from "@tanstack/react-query";
import { tailscaleApi } from "@/api/tailscale";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

export const tailscaleConnectionsKey = (companyId: string | null) => ["tailscale-connections", companyId] as const;

export function useTailscaleConnections(companyId: string | null) {
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(), enabled: Boolean(companyId), staleTime: 30_000 });
  const canManage = access.data?.source === "local_implicit" || access.data?.isInstanceAdmin === true;
  const connections = useQuery({
    queryKey: tailscaleConnectionsKey(companyId),
    queryFn: () => tailscaleApi.list(companyId!),
    enabled: Boolean(companyId) && canManage,
    staleTime: 30_000,
  });
  return { ...connections, data: canManage ? connections.data : undefined, canManage, access };
}
