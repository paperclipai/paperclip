// ---------------------------------------------------------------------------
// Gateway routing types
// ---------------------------------------------------------------------------

export type GatewayCircuitBreakerState = "closed" | "open" | "half_open";

export interface GatewayRoute {
  id: string;
  companyId: string;
  agentId: string | null;
  name: string;
  priority: number;
  adapterType: string;
  model: string;
  weight: number;
  isEnabled: boolean;

  quotaTokensPerMinute: number | null;
  quotaTokensPerHour: number | null;
  quotaTokensPerDay: number | null;
  quotaRequestsPerMinute: number | null;
  quotaRequestsPerHour: number | null;
  quotaRequestsPerDay: number | null;

  circuitBreakerEnabled: boolean;
  circuitBreakerFailureThreshold: number;
  circuitBreakerResetSec: number;

  timeoutSec: number | null;
  adapterConfigOverrides: Record<string, unknown> | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface GatewayRouteHealth {
  routeId: string;
  circuitState: GatewayCircuitBreakerState;
  failureCount: number;
  lastFailureAt: Date | null;
  openedAt: Date | null;
  usage: {
    minute: { tokens: number; requests: number };
    hour: { tokens: number; requests: number };
    day: { tokens: number; requests: number };
  };
}

export interface GatewayRouteWithHealth extends GatewayRoute {
  health: GatewayRouteHealth;
}

export interface GatewayRouteStat {
  routeId: string;
  windowType: string;
  windowKey: string;
  tokenCount: number;
  requestCount: number;
}
