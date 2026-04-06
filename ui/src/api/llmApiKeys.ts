import { api } from "./client";

export interface LlmApiKey {
  id: string;
  companyId: string;
  name: string;
  provider: string;
  apiKeyMasked: string;
  modelFilter: string | null;
  isDefault: boolean;
  isActive: boolean;
  priority: number;
  monthlyBudgetUsd: number | null;
  currentMonthSpendUsd: number;
  totalSpendUsd: number;
  totalRequests: number;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentKeyAssignment {
  id: string;
  agentId: string;
  llmApiKeyId: string;
  companyId: string;
  assignedBy: string;
  assignedAt: string;
  keyName?: string;
  keyProvider?: string;
}

export interface CreateLlmApiKeyInput {
  name: string;
  provider: string;
  apiKey: string;
  modelFilter?: string | null;
  isDefault?: boolean;
  priority?: number;
  monthlyBudgetUsd?: number | null;
  notes?: string | null;
}

export interface UpdateLlmApiKeyInput {
  name?: string;
  provider?: string;
  apiKey?: string;
  modelFilter?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  priority?: number;
  monthlyBudgetUsd?: number | null;
  notes?: string | null;
}

export const llmApiKeysApi = {
  list: (companyId: string) =>
    api.get<LlmApiKey[]>(`/companies/${companyId}/llm-api-keys`),

  get: (companyId: string, keyId: string) =>
    api.get<LlmApiKey>(`/companies/${companyId}/llm-api-keys/${keyId}`),

  create: (companyId: string, input: CreateLlmApiKeyInput) =>
    api.post<LlmApiKey>(`/companies/${companyId}/llm-api-keys`, input),

  update: (companyId: string, keyId: string, input: UpdateLlmApiKeyInput) =>
    api.patch<LlmApiKey>(`/companies/${companyId}/llm-api-keys/${keyId}`, input),

  delete: (companyId: string, keyId: string) =>
    api.delete<{ ok: boolean }>(`/companies/${companyId}/llm-api-keys/${keyId}`),

  // Agent assignments
  listAgentKeys: (companyId: string, agentId: string) =>
    api.get<AgentKeyAssignment[]>(`/companies/${companyId}/agents/${agentId}/llm-keys`),

  assignKeyToAgent: (companyId: string, agentId: string, llmApiKeyId: string, assignedBy?: string) =>
    api.post<AgentKeyAssignment>(`/companies/${companyId}/agents/${agentId}/llm-keys`, {
      llmApiKeyId,
      assignedBy,
    }),

  setAgentKey: (companyId: string, agentId: string, llmApiKeyId: string, assignedBy?: string) =>
    api.put<{ ok: boolean }>(`/companies/${companyId}/agents/${agentId}/llm-keys`, {
      llmApiKeyId,
      assignedBy,
    }),

  removeAgentKey: (companyId: string, agentId: string, keyId: string) =>
    api.delete<{ ok: boolean }>(`/companies/${companyId}/agents/${agentId}/llm-keys/${keyId}`),
};
