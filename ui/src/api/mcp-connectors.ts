import type { McpConnector, McpConnectorEnrollment } from "@paperclipai/shared";
import { api } from "./client";

/** Outbound MCP connectors (Tools & Access → Connectors). */
export const mcpConnectorsApi = {
  list: (companyId: string) =>
    api.get<{ connectors: McpConnector[] }>(`/companies/${companyId}/tools/mcp-connectors`),
  create: (companyId: string, input: { name: string }) =>
    api.post<McpConnectorEnrollment>(`/companies/${companyId}/tools/mcp-connectors`, input),
  reenroll: (companyId: string, connectorId: string) =>
    api.post<McpConnectorEnrollment>(`/companies/${companyId}/tools/mcp-connectors/${connectorId}/reenroll`, {}),
  revoke: (companyId: string, connectorId: string) =>
    api.post<McpConnector>(`/companies/${companyId}/tools/mcp-connectors/${connectorId}/revoke`, {}),
};
