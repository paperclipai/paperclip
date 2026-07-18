import type {
  AgentMcpServerBinding,
  AgentMcpServerBindingDetail,
  BindAgentMcpServerRequest,
  McpServer,
  McpServerCatalogSnapshot,
  McpServerDiscoveryResult,
  TestMcpServerRequest,
  UpdateAgentMcpServerBindingRequest,
  UpdateMcpServerRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export const mcpServersApi = {
  list: (companyId: string) =>
    api.get<McpServer[]>(`/companies/${encodeURIComponent(companyId)}/mcp-servers`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<McpServer>(`/companies/${encodeURIComponent(companyId)}/mcp-servers`, data),
  get: (id: string) =>
    api.get<McpServer>(`/mcp-servers/${encodeURIComponent(id)}`),
  update: (id: string, data: UpdateMcpServerRequest) =>
    api.patch<McpServer>(`/mcp-servers/${encodeURIComponent(id)}`, data),
  remove: (id: string) =>
    api.delete<{ ok: true }>(`/mcp-servers/${encodeURIComponent(id)}`),
  test: (id: string, data: TestMcpServerRequest) =>
    api.post<McpServerDiscoveryResult>(`/mcp-servers/${encodeURIComponent(id)}/test`, data),
  latestSnapshot: (id: string) =>
    api.get<McpServerCatalogSnapshot>(`/mcp-servers/${encodeURIComponent(id)}/catalog-snapshots/latest`),
  listAgentBindings: (agentId: string, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.get<AgentMcpServerBindingDetail[]>(
      `/agents/${encodeURIComponent(agentId)}/mcp-servers${suffix}`,
    );
  },
  bindToAgent: (agentId: string, data: BindAgentMcpServerRequest, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.post<AgentMcpServerBinding>(
      `/agents/${encodeURIComponent(agentId)}/mcp-servers${suffix}`,
      data,
    );
  },
  updateAgentBinding: (
    agentId: string,
    mcpServerId: string,
    data: UpdateAgentMcpServerBindingRequest,
    companyId?: string,
  ) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.patch<AgentMcpServerBinding>(
      `/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(mcpServerId)}${suffix}`,
      data,
    );
  },
  removeAgentBinding: (agentId: string, mcpServerId: string, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.delete<{ ok: true }>(
      `/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(mcpServerId)}${suffix}`,
    );
  },
};
