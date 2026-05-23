import { api } from "./client";

export interface AgentConnector {
  id: string;
  agentId: string;
  connectorType: string;
  provider: string;
  displayName: string | null;
  scopes: string[] | null;
  providerData: Record<string, unknown> | null;
  status: "pending" | "connected" | "error" | "revoked";
  errorMessage: string | null;
  connectedAt: string;
  updatedAt: string;
}

export interface ConnectorProvider {
  id: string;
  name: string;
  scopes: string[];
}

export interface CreatedConnector {
  connectorId: string;
  authUrl: string;
  status: string;
}

export const connectorsApi = {
  list: (agentId: string) =>
    api.get<AgentConnector[]>(`/agents/${agentId}/connectors`),

  providers: () =>
    api.get<ConnectorProvider[]>(`/connectors/providers`),

  create: (agentId: string, provider: string, displayName?: string) =>
    api.post<CreatedConnector>(`/agents/${agentId}/connectors`, {
      provider,
      displayName,
    }),

  delete: (agentId: string, connectorId: string) =>
    api.delete<{ success: boolean }>(`/agents/${agentId}/connectors/${connectorId}`),

  revoke: (agentId: string, connectorId: string) =>
    api.post<{ success: boolean }>(`/agents/${agentId}/connectors/${connectorId}/revoke`, {}),
};
