import { useQuery } from "@tanstack/react-query";
import { tailscaleApi } from "@/api/tailscale";

export const tailscaleConnectionsKey = (companyId: string | null) => ["tailscale-connections", companyId] as const;

export function useTailscaleConnections(companyId: string | null) {
  return useQuery({
    queryKey: tailscaleConnectionsKey(companyId),
    queryFn: () => tailscaleApi.list(companyId!),
    enabled: Boolean(companyId),
    staleTime: 30_000,
  });
}
