import type { McpServer, CreateMcpServer, UpdateMcpServer } from "@paperclipai/shared";
import { api } from "./client";

export const mcpServersApi = {
  list: (companyId: string) => api.get<McpServer[]>(`/companies/${companyId}/mcp-servers`),
  get: (id: string) => api.get<McpServer>(`/mcp-servers/${id}`),
  create: (companyId: string, data: CreateMcpServer) =>
    api.post<McpServer>(`/companies/${companyId}/mcp-servers`, data),
  update: (id: string, data: UpdateMcpServer) => api.patch<McpServer>(`/mcp-servers/${id}`, data),
  remove: (id: string) => api.delete<{ ok: true }>(`/mcp-servers/${id}`),
  listForAgent: (agentId: string) => api.get<McpServer[]>(`/agents/${agentId}/mcp-servers`),
  setForAgent: (agentId: string, mcpServerIds: string[]) =>
    api.put<McpServer[]>(`/agents/${agentId}/mcp-servers`, { mcpServerIds }),
};
