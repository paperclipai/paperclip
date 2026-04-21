import type { GatewayRouteWithHealth, GatewayRouteHealth } from "@paperclipai/shared";
import { api } from "./client";

export const gatewayApi = {
  listRoutes: (companyId: string, agentId?: string) =>
    api.get<GatewayRouteWithHealth[]>(
      `/companies/${companyId}/gateway/routes${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
    ),

  createRoute: (companyId: string, data: Record<string, unknown>) =>
    api.post<GatewayRouteWithHealth>(`/companies/${companyId}/gateway/routes`, data),

  updateRoute: (companyId: string, routeId: string, data: Record<string, unknown>) =>
    api.patch<GatewayRouteWithHealth>(
      `/companies/${companyId}/gateway/routes/${encodeURIComponent(routeId)}`,
      data,
    ),

  deleteRoute: (companyId: string, routeId: string) =>
    api.delete(`/companies/${companyId}/gateway/routes/${encodeURIComponent(routeId)}`),

  getHealth: (companyId: string) =>
    api.get<GatewayRouteHealth[]>(`/companies/${companyId}/gateway/health`),

  resetCircuit: (companyId: string, routeId: string) =>
    api.post<{ ok: boolean; health: GatewayRouteHealth }>(
      `/companies/${companyId}/gateway/routes/${encodeURIComponent(routeId)}/reset-circuit`,
      {},
    ),
};
