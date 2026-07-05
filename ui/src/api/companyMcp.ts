import type {
  CompanyMcpServer,
  CompanyMcpServerDetail,
  CompanyMcpServerListItem,
  McpServerConfig,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CompanyMcpServerCreateInput {
  name: string;
  description?: string | null;
  config: McpServerConfig;
  enabled?: boolean;
}

export interface CompanyMcpServerUpdateInput {
  name?: string;
  description?: string | null;
  config?: McpServerConfig;
  enabled?: boolean;
}

export const companyMcpApi = {
  list: (companyId: string) =>
    api.get<CompanyMcpServerListItem[]>(`/companies/${encodeURIComponent(companyId)}/mcp-servers`),
  detail: (companyId: string, serverId: string) =>
    api.get<CompanyMcpServerDetail>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers/${encodeURIComponent(serverId)}`,
    ),
  create: (companyId: string, payload: CompanyMcpServerCreateInput) =>
    api.post<CompanyMcpServer>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers`,
      payload,
    ),
  update: (companyId: string, serverId: string, payload: CompanyMcpServerUpdateInput) =>
    api.patch<CompanyMcpServer>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers/${encodeURIComponent(serverId)}`,
      payload,
    ),
  remove: (companyId: string, serverId: string, options?: { force?: boolean }) =>
    api.delete<{ success: true }>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers/${encodeURIComponent(serverId)}${options?.force ? "?force=true" : ""}`,
    ),
  startOauth: (companyId: string, serverId: string) =>
    api.post<{ authorizeUrl: string }>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers/${encodeURIComponent(serverId)}/oauth/start`,
      {},
    ),
};
