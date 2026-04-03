import { api } from "./client";

export interface AgentMemoryEntry {
  id: string;
  agentId: string;
  companyId: string;
  memoryType: string;
  category: string | null;
  content: string;
  sourceIssueId: string | null;
  sourceProjectId: string | null;
  confidence: number;
  accessCount: number;
  lastAccessedAt: Date | null;
  expiresAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export const agentMemoryApi = {
  list: (companyId: string, agentId: string, filters?: { memoryType?: string }) => {
    const params = new URLSearchParams();
    if (filters?.memoryType) params.set("memoryType", filters.memoryType);
    const qs = params.toString();
    return api.get<AgentMemoryEntry[]>(
      `/companies/${companyId}/agents/${agentId}/memory${qs ? `?${qs}` : ""}`,
    );
  },

  create: (companyId: string, agentId: string, data: Record<string, unknown>) =>
    api.post<AgentMemoryEntry>(
      `/companies/${companyId}/agents/${agentId}/memory`,
      data,
    ),

  update: (companyId: string, agentId: string, entryId: string, data: Record<string, unknown>) =>
    api.patch<AgentMemoryEntry>(
      `/companies/${companyId}/agents/${agentId}/memory/${entryId}`,
      data,
    ),

  remove: (companyId: string, agentId: string, entryId: string) =>
    api.delete<{ ok: true }>(
      `/companies/${companyId}/agents/${agentId}/memory/${entryId}`,
    ),
};
